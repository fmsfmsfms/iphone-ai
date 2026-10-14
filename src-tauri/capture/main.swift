// iphone-ai-capture: a live ScreenCaptureKit view of the iPhone Mirroring window.
//
// Streams the largest layer-0 window of `--bundle-id` (iPhone Mirroring by
// default) as JPEG frames on stdout for the iPhone AI backend
// (packages/server, LiveCapture service). Capture only: it never activates an
// app, moves the cursor or posts input, so unlike Mirroir's `screenshot` tool it
// has no side effects on the phone or on the Mirroring session.
//
// The wire format (length-prefixed STATUS / FRAME messages), stdin commands and
// exit codes are documented in README.md next to this file. Built by
// scripts/build-capture.mjs into src-tauri/binaries/iphone-ai-capture-<triple>
// and bundled as Contents/MacOS/iphone-ai-capture (Tauri externalBin).

import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit

// MARK: - Constants

let toolName = "iphone-ai-capture"
let protocolVersion = 1

enum MessageType: UInt8 {
  case status = 0x01
  case frame = 0x02
}

enum ExitCode {
  static let ok: Int32 = 0
  static let failure: Int32 = 1
  static let permission: Int32 = 2
  static let streamFailed: Int32 = 3
  static let usage: Int32 = 64
}

/// How often the window is looked up again (size changes, closed/reopened windows).
let windowCheckInterval: TimeInterval = 1
/// A window lookup that has not answered after this long is abandoned and retried.
let lookupTimeout: TimeInterval = 10
/// Windows smaller than this (points) are ignored (launch/teardown transients).
let minimumWindowSide: CGFloat = 50
/// Consecutive stream failures, without a frame in between, before the helper gives up.
let maxConsecutiveFailures = 5
/// While ScreenCaptureKit reports the content as unchanged (idle frames), the last
/// frame is re-sent at this interval so a consumer can tell a static screen from a
/// stalled stream.
let idleRepeatInterval: TimeInterval = 1
/// Idle reports older than this no longer count as "the content is unchanged".
let idleEvidenceWindow: TimeInterval = 1.5
let statsInterval: TimeInterval = 30
/// stopCapture() gets this long before the helper exits anyway.
let stopTimeout: TimeInterval = 2
/// Hard deadline after a stop request, even if stdout is blocked by a stalled reader.
let forcedExitTimeout: TimeInterval = 5

let permissionMessage =
  "Screen Recording is not granted to iPhone AI. Allow it in System Settings > Privacy & Security > "
  + "Screen & System Audio Recording, then reopen iPhone AI."

let usage = """
  usage: iphone-ai-capture [--bundle-id ID] [--fps N] [--max-long-edge PX] [--quality Q]

  Streams the iPhone Mirroring window with ScreenCaptureKit as JPEG frames on stdout
  (length-prefixed binary messages, see src-tauri/capture/README.md). Capture only:
  never activates apps, never moves the cursor, never posts input.

  options:
    --bundle-id ID       app whose window is captured (default com.apple.ScreenContinuity)
    --fps N              maximum frame rate, 1-60 (default 30)
    --max-long-edge PX   downscale so the longer side is at most PX pixels (default 1600)
    --quality Q          JPEG quality, 0.1-1 (default 0.7)
    --test-pattern       diagnostics: stream a synthetic 390x844 pt test pattern through the
                         same encoder and wire format without ScreenCaptureKit (needs no
                         Screen Recording permission; never shown to users as live capture)
    --version            print the protocol version and exit
    -h, --help           print this help and exit

  stdin: JSON lines {"cmd":"config","fps":N,"maxLongEdge":N,"quality":Q} or {"cmd":"stop"}.
  stdin EOF, SIGTERM, SIGINT or SIGHUP stop the capture and exit 0.
  exit codes: 0 stopped, 1 internal error, 2 Screen Recording not granted,
              3 capture kept failing, 64 bad arguments.
  """

// MARK: - Helpers

/// Human-readable diagnostics go to stderr only (raw write: never throws, even if stderr is closed).
func log(_ message: String) {
  let bytes = Array("\(toolName): \(message)\n".utf8)
  bytes.withUnsafeBufferPointer { buffer in
    _ = write(STDERR_FILENO, buffer.baseAddress, buffer.count)
  }
}

/// Monotonic seconds (unaffected by wall-clock changes).
func uptime() -> TimeInterval {
  ProcessInfo.processInfo.systemUptime
}

func epochMilliseconds() -> Int64 {
  Int64((Date().timeIntervalSince1970 * 1000).rounded())
}

func describe(_ error: Error) -> String {
  let error = error as NSError
  return "\(error.localizedDescription) (\(error.domain) \(error.code))"
}

/// Exits exactly once, whichever thread gets here first (a failed stdout write on the
/// encode queue can race a stop on the control queue); later callers just wait.
func terminate(_ code: Int32) -> Never {
  struct Gate {
    static let lock = NSLock()
    nonisolated(unsafe) static var exiting = false
  }
  Gate.lock.lock()
  let first = !Gate.exiting
  Gate.exiting = true
  Gate.lock.unlock()
  if first { exit(code) }
  while true { sleep(60) }
}

/// Hard deadline for a stop, independent of the queues (one may be blocked writing to a
/// full stdout pipe while the reader is stalled).
func scheduleForcedExit(_ code: Int32) {
  struct Once {
    static let lock = NSLock()
    nonisolated(unsafe) static var scheduled = false
  }
  let first: Bool = Once.lock.withLock {
    defer { Once.scheduled = true }
    return !Once.scheduled
  }
  guard first else { return }
  DispatchQueue.global().asyncAfter(deadline: .now() + forcedExitTimeout) {
    log("forced exit: stopping took longer than \(Int(forcedExitTimeout)) s")
    _exit(code)
  }
}

func isPermissionError(_ error: Error) -> Bool {
  let error = error as NSError
  return error.domain == SCStreamErrorDomain && error.code == SCStreamError.Code.userDeclined.rawValue
}

extension Data {
  mutating func appendUInt32BE(_ value: UInt32) {
    Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
  }
}

// MARK: - Options

struct Options {
  static let fpsRange = 1...60
  static let maxLongEdgeRange = 160...8192
  static let qualityRange = 0.1...1.0

  var bundleId = "com.apple.ScreenContinuity"
  var fps = 30
  var maxLongEdge = 1600
  var quality = 0.7
  /// Diagnostics: synthetic frames through the real encoder/output path, no ScreenCaptureKit.
  var testPattern = false
}

func clamped<T: Comparable>(_ value: T, to range: ClosedRange<T>, name: String) -> T {
  let result = min(max(value, range.lowerBound), range.upperBound)
  if result != value { log("\(name) \(value) is out of range \(range.lowerBound)-\(range.upperBound); using \(result)") }
  return result
}

func parseOptions(_ arguments: [String]) -> Options {
  func fail(_ message: String) -> Never {
    log(message)
    log("run with --help for usage")
    exit(ExitCode.usage)
  }

  var options = Options()
  var index = 0
  while index < arguments.count {
    var name = arguments[index]
    var inlineValue: String?
    if name.hasPrefix("--"), let equals = name.firstIndex(of: "=") {
      inlineValue = String(name[name.index(after: equals)...])
      name = String(name[..<equals])
    }
    func value() -> String {
      if let inlineValue { return inlineValue }
      index += 1
      guard index < arguments.count else { fail("\(name) needs a value") }
      return arguments[index]
    }
    switch name {
    case "-h", "--help":
      print(usage)
      exit(ExitCode.ok)
    case "--version":
      print("\(toolName) protocol \(protocolVersion)")
      exit(ExitCode.ok)
    case "--test-pattern":
      options.testPattern = true
    case "--bundle-id":
      let bundleId = value().trimmingCharacters(in: .whitespaces)
      guard !bundleId.isEmpty else { fail("--bundle-id must not be empty") }
      options.bundleId = bundleId
    case "--fps":
      let raw = value()
      guard let fps = Int(raw) else { fail("--fps expects an integer, got \"\(raw)\"") }
      options.fps = clamped(fps, to: Options.fpsRange, name: "--fps")
    case "--max-long-edge":
      let raw = value()
      guard let edge = Int(raw) else { fail("--max-long-edge expects an integer, got \"\(raw)\"") }
      options.maxLongEdge = clamped(edge, to: Options.maxLongEdgeRange, name: "--max-long-edge")
    case "--quality":
      let raw = value()
      guard let quality = Double(raw), quality.isFinite else { fail("--quality expects a number, got \"\(raw)\"") }
      options.quality = clamped(quality, to: Options.qualityRange, name: "--quality")
    default:
      fail("unknown option \(name)")
    }
    index += 1
  }
  return options
}

// MARK: - Geometry

/// Window size in points (the geometry Mirroir's tap coordinates use) and the
/// configured output size in pixels.
struct Geometry: Equatable {
  var ptW: Int
  var ptH: Int
  var pxW: Int
  var pxH: Int

  /// Output = window points x backing scale, downscaled proportionally to `maxLongEdge`.
  init(frame: CGRect, scale: CGFloat, maxLongEdge: Int) {
    ptW = Int(frame.width)  // truncated, like the integer sizes Mirroir reports
    ptH = Int(frame.height)
    let scale = scale > 0 ? Double(scale) : 2
    var width = Double(frame.width) * scale
    var height = Double(frame.height) * scale
    let longEdge = max(width, height)
    if longEdge > Double(maxLongEdge) {
      let factor = Double(maxLongEdge) / longEdge
      width *= factor
      height *= factor
    }
    pxW = max(1, Int(width.rounded()))
    pxH = max(1, Int(height.rounded()))
  }

  var fields: [String: Any] { ["ptW": ptW, "ptH": ptH, "pxW": pxW, "pxH": pxH] }
}

// MARK: - Output

/// Writes whole messages to stdout from one serial queue:
/// `[uint32 BE length of the rest][1 byte type][payload]`.
final class Output: @unchecked Sendable {
  private let queue = DispatchQueue(label: "iphone-ai-capture.stdout")
  private var closed = false

  /// STATUS (0x01): UTF-8 JSON `{"event": …, "message"?, "code"?, "ptW"?, "ptH"?, "pxW"?, "pxH"?}`.
  func status(_ event: String, _ fields: [String: Any] = [:]) {
    var object = fields
    object["event"] = event
    guard let json = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
      log("could not encode the \(event) status")
      return
    }
    var message = Data(capacity: 5 + json.count)
    message.appendUInt32BE(UInt32(1 + json.count))
    message.append(MessageType.status.rawValue)
    message.append(json)
    write(message)
  }

  /// FRAME (0x02): `[uint32 BE header length][header JSON][JPEG bytes]`.
  func frame(header: [String: Any], jpeg: Data) {
    guard let json = try? JSONSerialization.data(withJSONObject: header, options: [.sortedKeys]) else {
      log("could not encode a frame header")
      return
    }
    var message = Data(capacity: 9 + json.count + jpeg.count)
    message.appendUInt32BE(UInt32(1 + 4 + json.count + jpeg.count))
    message.append(MessageType.frame.rawValue)
    message.appendUInt32BE(UInt32(json.count))
    message.append(json)
    message.append(jpeg)
    write(message)
  }

  /// Waits for the message being written, then drops everything after it (used right before exit).
  func close() {
    queue.sync { closed = true }
  }

  /// Blocks while the reader is slow; the encoder drops frames meanwhile instead of queueing them.
  /// A failed write (reader gone) ends the process: nobody is listening any more.
  private func write(_ message: Data) {
    queue.sync {
      guard !closed else { return }
      var failure: Int32 = 0
      message.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        while offset < raw.count {
          let written = Darwin.write(STDOUT_FILENO, base + offset, raw.count - offset)
          if written > 0 {
            offset += written
          } else if written < 0 && errno == EINTR {
            continue
          } else {
            failure = written < 0 ? errno : EIO
            return
          }
        }
      }
      if failure != 0 {
        closed = true
        log("stdout write failed (\(String(cString: strerror(failure)))); exiting")
        terminate(failure == EPIPE ? ExitCode.ok : ExitCode.failure)
      }
    }
  }
}

// MARK: - Frame encoder

/// Turns complete ScreenCaptureKit frames into JPEG FRAME messages. At most one frame
/// is in flight (encoding or being written): newer frames are dropped meanwhile, never
/// queued, so the consumer always gets the freshest picture.
final class FrameEncoder: @unchecked Sendable {
  private struct LastFrame {
    var jpeg: Data
    var ptW: Int
    var ptH: Int
    var pxW: Int
    var pxH: Int
  }

  private let output: Output
  private let queue = DispatchQueue(label: "iphone-ai-capture.encode", qos: .userInteractive)
  private let context = CIContext(options: [.cacheIntermediates: false, .name: "iphone-ai-capture"])
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  private var timer: DispatchSourceTimer?
  /// Called (on the encode queue) after the first frame of each stream was written.
  var onFirstFrame: (() -> Void)?

  // Guarded by `lock`.
  private let lock = NSLock()
  private var stream: ObjectIdentifier?
  /// The current output geometry first, then the previous one (frames still in flight
  /// after a resize keep the point size they were captured with).
  private var geometries: [Geometry] = []
  private var quality: Double
  private var busy = false
  private var seq = 0
  private var last: LastFrame?
  private var lastSentAt: TimeInterval = 0
  private var lastIdleAt: TimeInterval = -.infinity
  private var deliveredForStream = false
  private var warnedSizeMismatch = false
  private var statsSince = uptime()
  private var framesSent = 0
  private var framesRepeated = 0
  private var framesDropped = 0
  private var encodeSeconds: TimeInterval = 0

  init(output: Output, quality: Double) {
    self.output = output
    self.quality = quality
  }

  /// Starts the idle-repeat / statistics timer.
  func start() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 0.25, repeating: 0.25, leeway: .milliseconds(50))
    timer.setEventHandler { [weak self] in
      self?.repeatIdleFrame()
      self?.logStatsIfDue()
    }
    timer.resume()
    self.timer = timer
  }

  /// Frames are accepted only from `source` (the current SCStream or test pattern) from now on.
  func begin(source: AnyObject, geometry: Geometry) {
    lock.withLock {
      self.stream = ObjectIdentifier(source)
      geometries = [geometry]
      last = nil
      lastIdleAt = -.infinity
      deliveredForStream = false
      warnedSizeMismatch = false
    }
  }

  func update(geometry: Geometry) {
    lock.withLock {
      guard geometries.first != geometry else { return }
      geometries = [geometry] + geometries.prefix(1)
      last = nil  // never repeat a frame of the old size
    }
  }

  func end() {
    lock.withLock {
      stream = nil
      geometries = []
      last = nil
    }
  }

  func setQuality(_ quality: Double) {
    lock.withLock { self.quality = quality }
  }

  /// A complete frame from `source` (called on the sample handler queue).
  func submit(_ pixelBuffer: CVPixelBuffer, capturedAt: Int64, from source: AnyObject) {
    let token = ObjectIdentifier(source)
    let quality: Double? = lock.withLock {
      guard self.stream == token else { return nil }
      guard !busy else {
        framesDropped += 1
        return nil
      }
      busy = true
      return self.quality
    }
    guard let quality else { return }
    queue.async { [self] in
      encode(pixelBuffer, capturedAt: capturedAt, quality: quality, token: token)
    }
  }

  /// ScreenCaptureKit reported that the content has not changed since the last frame.
  func noteIdle(from source: AnyObject) {
    let token = ObjectIdentifier(source)
    lock.withLock {
      if self.stream == token { lastIdleAt = uptime() }
    }
  }

  private func encode(_ pixelBuffer: CVPixelBuffer, capturedAt: Int64, quality: Double, token: ObjectIdentifier) {
    let started = uptime()
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let image = CIImage(cvPixelBuffer: pixelBuffer)
    let jpegOptions = [
      CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality
    ]
    let jpeg = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: jpegOptions)
    let elapsed = uptime() - started

    var header: [String: Any] = [:]
    var first = false
    var mismatch = false
    let accepted: Bool = lock.withLock {
      guard let jpeg, stream == token, let current = geometries.first else {
        busy = false
        return false
      }
      let geometry = geometries.first { $0.pxW == width && $0.pxH == height } ?? current
      if geometry.pxW != width || geometry.pxH != height, !warnedSizeMismatch {
        warnedSizeMismatch = true
        mismatch = true
      }
      seq += 1
      header = ["seq": seq, "ts": capturedAt, "ptW": geometry.ptW, "ptH": geometry.ptH, "pxW": width, "pxH": height]
      last = LastFrame(jpeg: jpeg, ptW: geometry.ptW, ptH: geometry.ptH, pxW: width, pxH: height)
      first = !deliveredForStream
      deliveredForStream = true
      framesSent += 1
      encodeSeconds += elapsed
      return true
    }
    guard accepted, let jpeg else {
      if jpeg == nil { log("JPEG encoding failed for a \(width)x\(height) frame") }
      return
    }
    if mismatch {
      log("frame size \(width)x\(height) does not match the configured output; labelling it with the current window size")
    }
    output.frame(header: header, jpeg: jpeg)
    lock.withLock {
      busy = false
      lastSentAt = uptime()
    }
    if first {
      log(String(format: "first frame: %dx%d px, %d KB, encoded in %.1f ms", width, height, jpeg.count / 1024, elapsed * 1000))
      onFirstFrame?()
    }
  }

  /// Re-sends the last frame (new seq, ts = now) while ScreenCaptureKit keeps reporting
  /// that the window content is unchanged. Without fresh idle reports nothing is sent,
  /// so a stalled stream still looks stalled.
  private func repeatIdleFrame() {
    let now = uptime()
    var header: [String: Any] = [:]
    let frame: LastFrame? = lock.withLock {
      guard !busy, stream != nil, let last,
        now - lastSentAt >= idleRepeatInterval,
        now - lastIdleAt <= idleEvidenceWindow
      else { return nil }
      busy = true
      seq += 1
      framesRepeated += 1
      header = ["seq": seq, "ts": epochMilliseconds(), "ptW": last.ptW, "ptH": last.ptH, "pxW": last.pxW, "pxH": last.pxH]
      return last
    }
    guard let frame else { return }
    output.frame(header: header, jpeg: frame.jpeg)
    lock.withLock {
      busy = false
      lastSentAt = uptime()
    }
  }

  private func logStatsIfDue() {
    let now = uptime()
    let line: String? = lock.withLock {
      guard now - statsSince >= statsInterval else { return nil }
      defer {
        statsSince = now
        framesSent = 0
        framesRepeated = 0
        framesDropped = 0
        encodeSeconds = 0
      }
      guard framesSent + framesRepeated + framesDropped > 0 else { return nil }
      let seconds = now - statsSince
      let average = framesSent > 0 ? encodeSeconds / Double(framesSent) * 1000 : 0
      return String(
        format: "last %.0f s: %d frames (%.1f fps), %d idle repeats, %d dropped while busy, encode avg %.1f ms",
        seconds, framesSent, Double(framesSent) / seconds, framesRepeated, framesDropped, average)
    }
    if let line { log(line) }
  }
}

// MARK: - Test pattern

/// `--test-pattern`: a moving bar on a dark background at the configured fps, then
/// three seconds of "unchanged content" (idle reports) in every five, so the
/// encoder, idle repeats, framing, stdin commands and signals can be exercised
/// without Screen Recording permission.
final class TestPattern: @unchecked Sendable {
  static let windowFrame = CGRect(x: 0, y: 0, width: 390, height: 844)
  static let scale: CGFloat = 2

  let geometry: Geometry
  private let fps: Int
  private let encoder: FrameEncoder
  private let queue = DispatchQueue(label: "iphone-ai-capture.test-pattern", qos: .userInteractive)
  private var timer: DispatchSourceTimer?
  private var tick = 0

  init(maxLongEdge: Int, fps: Int, encoder: FrameEncoder) {
    geometry = Geometry(frame: Self.windowFrame, scale: Self.scale, maxLongEdge: maxLongEdge)
    self.fps = fps
    self.encoder = encoder
  }

  func start() {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1 / Double(fps), leeway: .milliseconds(2))
    timer.setEventHandler { [weak self] in self?.step() }
    timer.resume()
    self.timer = timer
  }

  func stop() {
    timer?.cancel()
    timer = nil
  }

  private func step() {
    tick += 1
    let phase = tick % (fps * 5)
    if phase >= fps * 2 {
      encoder.noteIdle(from: self)
      return
    }
    guard let buffer = makeBuffer(phase: phase) else {
      log("test pattern: could not allocate a \(geometry.pxW)x\(geometry.pxH) pixel buffer")
      return
    }
    encoder.submit(buffer, capturedAt: epochMilliseconds(), from: self)
  }

  private func makeBuffer(phase: Int) -> CVPixelBuffer? {
    var created: CVPixelBuffer?
    let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault, geometry.pxW, geometry.pxH, kCVPixelFormatType_32BGRA, attributes, &created)
    guard status == kCVReturnSuccess, let buffer = created else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    let width = geometry.pxW
    let height = geometry.pxH
    let barHeight = max(1, height / 20)
    let barTop = (phase * height / max(1, fps * 2)) % height
    for row in 0..<height {
      let pixels = (base + row * rowBytes).assumingMemoryBound(to: UInt32.self)
      let inBar = row >= barTop && row < barTop + barHeight
      // Little-endian BGRA: 0xAARRGGBB.
      pixels.update(repeating: inBar ? 0xFF_F2_F2_F2 : 0xFF_10_14_1C, count: width)
    }
    return buffer
  }
}

// MARK: - Capture controller

/// Finds the window, runs one SCStream for it and follows size changes, closed and
/// reopened windows. All state lives on `queue`.
final class CaptureController: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
  private let output: Output
  private let encoder: FrameEncoder
  private let queue = DispatchQueue(label: "iphone-ai-capture.control")
  private let sampleQueue = DispatchQueue(label: "iphone-ai-capture.samples", qos: .userInteractive)

  private var options: Options
  private var timer: DispatchSourceTimer?
  private var stream: SCStream?
  private var pattern: TestPattern?
  private var streamWindow: CGWindowID = 0
  /// Window frame (points) and backing scale the current configuration was built for.
  private var streamFrame: CGRect = .zero
  private var streamScale: CGFloat = 0
  private var geometry: Geometry?
  private var waitingReported = false
  private var lookupGeneration = 0
  private var lookupStartedAt: TimeInterval?
  private var lastLookupError: String?
  /// A stream failure is reported once the next lookup shows the window still exists
  /// (a closed window is "waiting", not an error).
  private var pendingFailure: String?
  private var consecutiveFailures = 0
  private var stopping = false
  private var exited = false

  init(options: Options, output: Output) {
    self.options = options
    self.output = output
    self.encoder = FrameEncoder(output: output, quality: options.quality)
    super.init()
    encoder.onFirstFrame = { [weak self] in
      guard let self else { return }
      self.queue.async { self.consecutiveFailures = 0 }
    }
  }

  func start() {
    log(
      "capturing \(options.bundleId) at up to \(options.fps) fps, long edge <= \(options.maxLongEdge) px, "
        + "JPEG quality \(options.quality)")
    encoder.start()
    if options.testPattern {
      queue.async { [self] in startTestPattern() }
      return
    }
    queue.async { [self] in
      let timer = DispatchSource.makeTimerSource(queue: queue)
      timer.schedule(deadline: .now() + windowCheckInterval, repeating: windowCheckInterval, leeway: .milliseconds(100))
      timer.setEventHandler { [weak self] in self?.checkWindow() }
      timer.resume()
      self.timer = timer
      checkWindow()
    }
  }

  /// `{"cmd":"config"}`: any subset of fps / maxLongEdge / quality.
  func configure(fps: Int?, maxLongEdge: Int?, quality: Double?) {
    queue.async { [self] in
      guard !stopping else { return }
      var changes: [String] = []
      var restream = false
      if let quality, quality != options.quality {
        options.quality = quality
        encoder.setQuality(quality)
        changes.append("quality \(quality)")
      }
      if let fps, fps != options.fps {
        options.fps = fps
        restream = true
        changes.append("fps \(fps)")
      }
      if let maxLongEdge, maxLongEdge != options.maxLongEdge {
        options.maxLongEdge = maxLongEdge
        restream = true
        changes.append("max long edge \(maxLongEdge) px")
      }
      guard !changes.isEmpty else { return }
      log("config: \(changes.joined(separator: ", "))")
      if restream, pattern != nil { startTestPattern() }
      if restream, stream != nil { reconfigure(frame: streamFrame, scale: streamScale) }
    }
  }

  /// Stops capturing and exits. Safe to call from any thread, any number of times.
  func stop(exitCode: Int32, reason: String) {
    scheduleForcedExit(exitCode)  // the control queue itself may be blocked on stdout
    queue.async { [self] in finish(exitCode: exitCode, reason: reason, announce: true) }
  }

  /// (Re)starts the synthetic source; "started" first, "window" when the size changes.
  private func startTestPattern() {
    let previous = pattern
    previous?.stop()
    let pattern = TestPattern(maxLongEdge: options.maxLongEdge, fps: options.fps, encoder: encoder)
    self.pattern = pattern
    let changed = pattern.geometry != geometry
    geometry = pattern.geometry
    encoder.begin(source: pattern, geometry: pattern.geometry)
    pattern.start()
    if previous == nil {
      log(
        "test pattern: \(pattern.geometry.ptW)x\(pattern.geometry.ptH) pt -> "
          + "\(pattern.geometry.pxW)x\(pattern.geometry.pxH) px; ScreenCaptureKit is not used")
      output.status("started", pattern.geometry.fields.merging(["message": "Test pattern (no screen capture)."]) { a, _ in a })
    } else if changed {
      output.status("window", pattern.geometry.fields)
    }
  }

  // MARK: Window tracking

  private func checkWindow() {
    guard !stopping else { return }
    if let startedAt = lookupStartedAt {
      guard uptime() - startedAt >= lookupTimeout else { return }  // one lookup at a time
      log("window lookup did not answer within \(Int(lookupTimeout)) s; retrying")
    }
    lookupGeneration += 1
    let generation = lookupGeneration
    lookupStartedAt = uptime()
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { [weak self] content, error in
      guard let self else { return }
      self.queue.async {
        guard generation == self.lookupGeneration, !self.stopping else { return }
        self.lookupStartedAt = nil
        if let error {
          self.lookupFailed(error)
        } else {
          self.lastLookupError = nil
          self.apply(window: content.flatMap { self.pickWindow(in: $0) })
        }
      }
    }
  }

  /// Largest layer-0 window of the app (on-screen windows first).
  private func pickWindow(in content: SCShareableContent) -> SCWindow? {
    content.windows
      .filter {
        $0.owningApplication?.bundleIdentifier == options.bundleId && $0.windowLayer == 0
          && $0.frame.width >= minimumWindowSide && $0.frame.height >= minimumWindowSide
      }
      .max { a, b in
        if a.isOnScreen != b.isOnScreen { return !a.isOnScreen }
        return a.frame.width * a.frame.height < b.frame.width * b.frame.height
      }
  }

  private func lookupFailed(_ error: Error) {
    if isPermissionError(error) || !CGPreflightScreenCaptureAccess() {
      permissionDenied("window lookup: \(describe(error))")
      return
    }
    let message = describe(error)
    if message != lastLookupError {
      lastLookupError = message
      log("window lookup failed: \(message)")
    }
  }

  private func apply(window: SCWindow?) {
    guard let window else {
      pendingFailure = nil
      if stream != nil {
        log("the window is gone; waiting for it to come back")
        tearDown()
      }
      if !waitingReported {
        waitingReported = true
        log("no \(options.bundleId) window; checking again every \(Int(windowCheckInterval)) s")
        output.status(
          "waiting",
          ["code": "no_window", "message": "Waiting for the iPhone Mirroring window (\(options.bundleId))."])
      }
      return
    }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let scale = CGFloat(filter.pointPixelScale)
    if stream != nil, streamWindow == window.windowID {
      if Int(window.frame.width) != Int(streamFrame.width) || Int(window.frame.height) != Int(streamFrame.height)
        || scale != streamScale
      {
        reconfigure(frame: window.frame, scale: scale)
      }
      return
    }
    if stream != nil {
      log("the window changed (id \(streamWindow) -> \(window.windowID)); restarting the capture")
      tearDown()
    }
    if let failure = pendingFailure {
      pendingFailure = nil
      consecutiveFailures += 1
      output.status("error", ["code": "stream_failed", "message": failure])
      if consecutiveFailures >= maxConsecutiveFailures {
        log("capture failed \(consecutiveFailures) times in a row; giving up")
        output.status(
          "error",
          [
            "code": "stream_failed",
            "message": "The capture failed \(consecutiveFailures) times in a row; giving up.",
          ])
        finish(exitCode: ExitCode.streamFailed, reason: "capture kept failing", announce: false)
        return
      }
    }
    startStream(window: window, filter: filter, scale: scale)
  }

  // MARK: Stream lifecycle

  private func makeConfiguration(_ geometry: Geometry) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    configuration.width = geometry.pxW
    configuration.height = geometry.pxH
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.colorSpaceName = CGColorSpace.sRGB
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
    configuration.queueDepth = 4
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.capturesAudio = false
    return configuration
  }

  private func startStream(window: SCWindow, filter: SCContentFilter, scale: CGFloat) {
    let geometry = Geometry(frame: window.frame, scale: scale, maxLongEdge: options.maxLongEdge)
    let stream = SCStream(filter: filter, configuration: makeConfiguration(geometry), delegate: self)
    do {
      try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
    } catch {
      pendingFailure = "could not attach the frame output: \(describe(error))"
      log(pendingFailure!)
      return
    }
    self.stream = stream
    self.geometry = geometry
    streamWindow = window.windowID
    streamFrame = window.frame
    streamScale = scale
    encoder.begin(source: stream, geometry: geometry)
    log(
      "starting capture of window \(window.windowID): \(geometry.ptW)x\(geometry.ptH) pt @\(scale)x -> "
        + "\(geometry.pxW)x\(geometry.pxH) px, \(options.fps) fps")
    stream.startCapture { [weak self] error in
      guard let self else { return }
      self.queue.async {
        guard self.stream === stream, !self.stopping else { return }
        if let error {
          self.streamFailed(error, during: "start")
          return
        }
        self.waitingReported = false
        self.output.status("started", geometry.fields)
      }
    }
  }

  /// Window resized / moved to a display with another scale, or fps / maxLongEdge changed.
  private func reconfigure(frame: CGRect, scale: CGFloat) {
    guard let stream else { return }
    let geometry = Geometry(frame: frame, scale: scale, maxLongEdge: options.maxLongEdge)
    let changed = geometry != self.geometry
    streamFrame = frame
    streamScale = scale
    self.geometry = geometry
    encoder.update(geometry: geometry)
    if changed {
      log("window is now \(geometry.ptW)x\(geometry.ptH) pt @\(scale)x -> \(geometry.pxW)x\(geometry.pxH) px")
    }
    stream.updateConfiguration(makeConfiguration(geometry)) { [weak self] error in
      guard let self else { return }
      self.queue.async {
        guard self.stream === stream, !self.stopping else { return }
        if let error {
          if isPermissionError(error) {
            self.permissionDenied("updateConfiguration: \(describe(error))")
            return
          }
          self.pendingFailure = "could not apply the new capture size: \(describe(error))"
          log(self.pendingFailure!)
          self.tearDown()
          return
        }
        if changed { self.output.status("window", geometry.fields) }
      }
    }
  }

  private func streamFailed(_ error: Error, during phase: String) {
    tearDown()
    if isPermissionError(error) {
      permissionDenied("\(phase): \(describe(error))")
      return
    }
    // Reported (or turned into "waiting") by the next window check.
    pendingFailure = "capture \(phase) failed: \(describe(error))"
    log(pendingFailure!)
  }

  private func tearDown() {
    guard let stream else { return }
    self.stream = nil
    geometry = nil
    streamWindow = 0
    encoder.end()
    try? stream.removeStreamOutput(self, type: .screen)
    stream.stopCapture { _ in }  // already stopped after a failure: the error is expected
  }

  private func permissionDenied(_ detail: String) {
    log("Screen Recording permission denied (\(detail))")
    output.status("error", ["code": "permission", "message": permissionMessage])
    finish(exitCode: ExitCode.permission, reason: "Screen Recording permission denied", announce: false)
  }

  /// Stops the stream, optionally announces "stopped", flushes stdout and exits.
  private func finish(exitCode: Int32, reason: String, announce: Bool) {
    guard !stopping else { return }
    stopping = true
    scheduleForcedExit(exitCode)
    timer?.cancel()
    timer = nil
    pattern?.stop()
    pattern = nil
    encoder.end()
    log("stopping: \(reason)")
    let exitNow: () -> Void = { [self] in
      guard !exited else { return }
      exited = true
      if announce { output.status("stopped", ["message": reason]) }
      output.close()
      terminate(exitCode)
    }
    guard let stream else {
      exitNow()
      return
    }
    self.stream = nil
    try? stream.removeStreamOutput(self, type: .screen)
    stream.stopCapture { [weak self] error in
      if let error { log("stopCapture: \(describe(error))") }
      self?.queue.async(execute: exitNow)
    }
    queue.asyncAfter(deadline: .now() + stopTimeout) {
      log("stopCapture did not finish within \(Int(stopTimeout)) s")
      exitNow()
    }
  }

  // MARK: SCStreamDelegate / SCStreamOutput

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    queue.async { [self] in
      guard self.stream === stream, !stopping else { return }
      streamFailed(error, during: "stream")
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sampleBuffer.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let info = attachments.first,
      let rawStatus = info[.status] as? Int,
      let status = SCFrameStatus(rawValue: rawStatus)
    else { return }
    switch status {
    case .complete, .started:
      // `.started` is the stream's first frame; on a static screen it may be the only one
      // with pixels before the idle reports. Idle / blank / suspended samples carry no new picture.
      guard let pixelBuffer = sampleBuffer.imageBuffer else { return }
      encoder.submit(pixelBuffer, capturedAt: captureTime(of: sampleBuffer), from: stream)
    case .idle:
      encoder.noteIdle(from: stream)
    default:
      break
    }
  }

  /// Wall-clock time the frame was captured: its host-clock presentation time mapped to epoch ms.
  private func captureTime(of sampleBuffer: CMSampleBuffer) -> Int64 {
    let now = epochMilliseconds()
    let presented = sampleBuffer.presentationTimeStamp
    guard presented.isValid, presented.isNumeric else { return now }
    let age = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), presented).seconds
    guard age.isFinite, age >= 0, age < 5 else { return now }
    return now - Int64((age * 1000).rounded())
  }
}

// MARK: - stdin commands

/// A JSON number (not a boolean); out-of-range values are clamped by the caller.
func jsonNumber(_ value: Any?) -> Double? {
  guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
  let double = value.doubleValue
  return double.isFinite ? double : nil
}

func jsonInteger(_ value: Any?) -> Int? {
  jsonNumber(value).map { Int(min(max($0, -1_000_000), 1_000_000).rounded()) }
}

func handleCommand(_ line: String, controller: CaptureController) {
  let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return }
  guard let data = trimmed.data(using: .utf8),
    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let command = object["cmd"] as? String
  else {
    log("ignoring a malformed command line (\(trimmed.utf8.count) bytes)")
    return
  }
  switch command {
  case "config":
    let fps = jsonInteger(object["fps"]).map { clamped($0, to: Options.fpsRange, name: "fps") }
    let maxLongEdge = jsonInteger(object["maxLongEdge"]).map {
      clamped($0, to: Options.maxLongEdgeRange, name: "maxLongEdge")
    }
    let quality = jsonNumber(object["quality"]).map { clamped($0, to: Options.qualityRange, name: "quality") }
    controller.configure(fps: fps, maxLongEdge: maxLongEdge, quality: quality)
  case "stop":
    controller.stop(exitCode: ExitCode.ok, reason: "stop requested")
  default:
    log("ignoring unknown command \"\(command.prefix(40))\"")
  }
}

// MARK: - Entry point

@main
enum CaptureMain {
  static func main() {
    // A closed stdout must surface as EPIPE from write(2), not kill the process.
    signal(SIGPIPE, SIG_IGN)
    let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
    let output = Output()

    // Checked before touching ScreenCaptureKit, which could otherwise show a permission prompt.
    guard options.testPattern || CGPreflightScreenCaptureAccess() else {
      log("Screen Recording permission is not granted to this process (or the app that launched it)")
      output.status("error", ["code": "permission", "message": permissionMessage])
      output.close()
      terminate(ExitCode.permission)
    }

    let controller = CaptureController(options: options, output: output)

    var signalSources: [DispatchSourceSignal] = []
    for (signalNumber, name) in [(SIGTERM, "SIGTERM"), (SIGINT, "SIGINT"), (SIGHUP, "SIGHUP")] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global())
      source.setEventHandler { controller.stop(exitCode: ExitCode.ok, reason: name) }
      source.resume()
      signalSources.append(source)
    }

    let reader = Thread {
      while let line = readLine(strippingNewline: true) {
        handleCommand(line, controller: controller)
      }
      controller.stop(exitCode: ExitCode.ok, reason: "stdin closed")
    }
    reader.name = "stdin"
    reader.start()

    controller.start()
    withExtendedLifetime(signalSources) { dispatchMain() }
  }
}
