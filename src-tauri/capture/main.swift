// iphone-ai-capture: a live ScreenCaptureKit view of the iPhone Mirroring window.
//
// Captures the largest layer-0 window of `--bundle-id` (iPhone Mirroring by
// default) as JPEG frames on stdout for the iPhone AI backend
// (packages/server, LiveCapture service). Capture only: it never activates an
// app, moves the cursor or posts input, so unlike Mirroir's `screenshot` tool it
// has no side effects on the phone or on the Mirroring session.
//
// Two capture modes:
//   snapshot (default)    one SCScreenshotManager screenshot of the window at a time, up to
//                         15 fps: the same single-shot capture Mirroir's own screenshot makes.
//   stream (diagnostics)  a continuous SCStream. Not used by the app: every SCStream start
//                         makes iPhone Mirroring add overlay UI that Mirroir reads as "Paused"
//                         (see CaptureMode).
//
// The wire format (length-prefixed STATUS / FRAME messages), stdin commands and
// exit codes are documented in README.md next to this file. Built by
// scripts/build-capture.mjs into src-tauri/binaries/iphone-ai-capture-<triple>
// (with capture/Info.plist embedded, making it a background-only process) and
// bundled as Contents/MacOS/iphone-ai-capture (Tauri externalBin).

import AppKit
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
/// Consecutive capture failures, without a frame in between, before the helper gives up.
let maxConsecutiveFailures = 5
/// A snapshot that has not answered after this long counts as a failed capture.
let snapshotTimeout: TimeInterval = 10
/// While the content is unchanged (ScreenCaptureKit idle frames, or snapshots identical
/// to the last frame), the last frame is re-sent at this interval so a consumer can tell
/// a static screen from a stalled capture.
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

/// Printed on stderr when the embedded Info.plist is not in effect (scripts/package-mac.mjs
/// looks for this text).
let backgroundOnlyWarning = "the embedded Info.plist is not in effect"

let usage = """
  usage: iphone-ai-capture [--mode snapshot|stream] [--bundle-id ID] [--fps N] [--max-long-edge PX]
                           [--quality Q]

  Captures the iPhone Mirroring window with ScreenCaptureKit as JPEG frames on stdout
  (length-prefixed binary messages, see src-tauri/capture/README.md). Capture only:
  never activates apps, never moves the cursor, never posts input.

  options:
    --mode MODE          snapshot (default): one window screenshot at a time, like Mirroir's
                         own screenshot; unchanged screenshots are not re-sent, the last frame
                         is repeated once per second instead.
                         stream: diagnostics only, a continuous SCStream; iPhone Mirroring
                         reacts to it with overlay UI that Mirroir reads as "Paused".
    --bundle-id ID       app whose window is captured (default com.apple.ScreenContinuity)
    --fps N              maximum frame rate: 1-15 in snapshot mode (default 15),
                         1-60 in stream mode (default 30)
    --max-long-edge PX   downscale so the longer side is at most PX pixels (default 1600)
    --quality Q          JPEG quality, 0.1-1 (default 0.7)
    --test-pattern       diagnostics: capture a synthetic 390x844 pt test pattern (2 s of
                         motion, then 3 s unchanged, in every 5 s) instead of the window,
                         through the snapshot pacing, idle repeats, encoder and wire format,
                         without ScreenCaptureKit (needs no Screen Recording permission; never
                         shown to users as live capture). Not combinable with --mode stream.
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

/// A failure detected by the helper itself (not reported by ScreenCaptureKit).
func helperError(_ message: String) -> NSError {
  NSError(domain: toolName, code: 1, userInfo: [NSLocalizedDescriptionKey: message])
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

enum CaptureMode: String {
  /// One `SCScreenshotManager` screenshot of the window at a time (never overlapping), the
  /// same single-shot capture Mirroir's own `screenshot` tool makes. The default.
  case snapshot
  /// Diagnostics only: a continuous SCStream. Every SCStream start makes iPhone Mirroring
  /// receive a ScreenSharingKit "window streaming started" notification and add overlay UI
  /// with a native control to its window. Mirroir 0.40.1's accessibility-based pause
  /// detection (any button or labelled text under the window's first child) then reports
  /// the live session as "Paused — connection paused" and Mirroir refuses all input.
  /// Screenshots do not trigger that overlay.
  case stream

  /// Frame rates the mode can deliver: snapshots are taken one at a time.
  var fpsRange: ClosedRange<Int> { self == .snapshot ? 1...15 : 1...60 }
  var defaultFps: Int { self == .snapshot ? 15 : 30 }
}

struct Options {
  static let maxLongEdgeRange = 160...8192
  static let qualityRange = 0.1...1.0

  var mode = CaptureMode.snapshot
  var bundleId = "com.apple.ScreenContinuity"
  var fps = CaptureMode.snapshot.defaultFps
  var maxLongEdge = 1600
  var quality = 0.7
  /// Diagnostics: a synthetic source for the snapshot loop (real pacing, idle repeats,
  /// encoder and output path), no ScreenCaptureKit.
  var testPattern = false
}

func clamped<T: Comparable>(_ value: T, to range: ClosedRange<T>, name: String, note: String = "") -> T {
  let result = min(max(value, range.lowerBound), range.upperBound)
  if result != value {
    log("\(name) \(value) is out of range \(range.lowerBound)-\(range.upperBound)\(note); using \(result)")
  }
  return result
}

func parseOptions(_ arguments: [String]) -> Options {
  func fail(_ message: String) -> Never {
    log(message)
    log("run with --help for usage")
    exit(ExitCode.usage)
  }

  var options = Options()
  var fps: Int?  // clamped once the mode is known
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
    case "--mode":
      let raw = value()
      guard let mode = CaptureMode(rawValue: raw) else { fail("--mode expects snapshot or stream, got \"\(raw)\"") }
      options.mode = mode
    case "--bundle-id":
      let bundleId = value().trimmingCharacters(in: .whitespaces)
      guard !bundleId.isEmpty else { fail("--bundle-id must not be empty") }
      options.bundleId = bundleId
    case "--fps":
      let raw = value()
      guard let parsed = Int(raw) else { fail("--fps expects an integer, got \"\(raw)\"") }
      fps = parsed
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
  if options.testPattern && options.mode == .stream {
    fail("--test-pattern runs through the snapshot loop; it cannot be combined with --mode stream")
  }
  options.fps = fps.map { clamped($0, to: options.mode.fpsRange, name: "--fps", note: " in \(options.mode) mode") }
    ?? options.mode.defaultFps
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

/// Output size and pixel options shared by both capture modes.
func captureConfiguration(_ geometry: Geometry) -> SCStreamConfiguration {
  let configuration = SCStreamConfiguration()
  configuration.width = geometry.pxW
  configuration.height = geometry.pxH
  configuration.pixelFormat = kCVPixelFormatType_32BGRA
  configuration.colorSpaceName = CGColorSpace.sRGB
  configuration.showsCursor = false
  configuration.ignoreShadowsSingleWindow = true
  configuration.capturesAudio = false
  return configuration
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

/// Turns captured pictures (SCStream frames or snapshots) into JPEG FRAME messages. At
/// most one frame is in flight (encoding or being written): newer stream frames are
/// dropped meanwhile, never queued, so the consumer always gets the freshest picture;
/// the snapshot loop instead waits for each frame before its next capture.
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

  /// Frames are accepted only from `source` (the current SCStream or snapshot loop) from now on.
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
      encode(
        CIImage(cvPixelBuffer: pixelBuffer), width: CVPixelBufferGetWidth(pixelBuffer),
        height: CVPixelBufferGetHeight(pixelBuffer), capturedAt: capturedAt, quality: quality, token: token)
    }
  }

  /// A snapshot from `source` (snapshot mode). Never dropped: `done(sent)` is called on the
  /// encode queue once the frame was written (true) or rejected (false), and the snapshot
  /// loop waits for it before its next capture, so a slow reader slows the captures down.
  func submit(_ image: CGImage, capturedAt: Int64, from source: AnyObject, done: @escaping (Bool) -> Void) {
    let token = ObjectIdentifier(source)
    queue.async { [self] in
      let quality: Double? = lock.withLock {
        guard self.stream == token else { return nil }
        busy = true
        return self.quality
      }
      guard let quality else { return done(false) }
      done(
        encode(
          CIImage(cgImage: image), width: image.width, height: image.height, capturedAt: capturedAt,
          quality: quality, token: token))
    }
  }

  /// The content has not changed since the last frame: ScreenCaptureKit reported an idle
  /// frame, or a snapshot was identical to the last one sent.
  func noteIdle(from source: AnyObject) {
    let token = ObjectIdentifier(source)
    lock.withLock {
      if self.stream == token { lastIdleAt = uptime() }
    }
  }

  /// Encodes and writes one frame; false when it was not sent (encoding failed, or the
  /// source is no longer current).
  @discardableResult
  private func encode(
    _ image: CIImage, width: Int, height: Int, capturedAt: Int64, quality: Double, token: ObjectIdentifier
  ) -> Bool {
    let started = uptime()
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
      return false
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
    return true
  }

  /// Re-sends the last frame (new seq, ts = now) while the source keeps reporting that the
  /// window content is unchanged (`noteIdle`). Without fresh idle reports nothing is sent,
  /// so a stalled capture still looks stalled.
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

// MARK: - Snapshot mode

/// Where the snapshot loop gets its pictures. `completion` is called exactly once, on any queue.
protocol SnapshotSource {
  func capture(_ geometry: Geometry, completion: @escaping (Result<CGImage, Error>) -> Void)
}

/// One `SCScreenshotManager` screenshot of the window per call: the single-shot capture
/// Mirroir's own screenshot tool makes, which (unlike an SCStream) iPhone Mirroring does
/// not react to.
struct WindowSnapshotSource: SnapshotSource {
  let filter: SCContentFilter

  func capture(_ geometry: Geometry, completion: @escaping (Result<CGImage, Error>) -> Void) {
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: captureConfiguration(geometry)) {
      image, error in
      if let image {
        completion(.success(image))
      } else {
        completion(.failure(error ?? helperError("the screenshot returned no image")))
      }
    }
  }
}

/// `--test-pattern`: a synthetic window instead of screenshots, so the snapshot loop's
/// pacing, unchanged-image detection, idle repeats, encoder, framing, stdin commands and
/// signals can be exercised without Screen Recording permission. A bar moves down a dark
/// background for 2 s, then stands still (in another colour) for 3 s, in every 5 s.
final class TestPatternSource: SnapshotSource {
  static let windowFrame = CGRect(x: 0, y: 0, width: 390, height: 844)
  static let scale: CGFloat = 2
  static let motionSeconds: TimeInterval = 2
  static let cycleSeconds: TimeInterval = 5

  private let startedAt = uptime()
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

  func capture(_ geometry: Geometry, completion: @escaping (Result<CGImage, Error>) -> Void) {
    let width = geometry.pxW
    let height = geometry.pxH
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else {
      completion(.failure(helperError("test pattern: could not create a \(width)x\(height) bitmap")))
      return
    }
    context.setFillColor(red: 0x10 / 255, green: 0x14 / 255, blue: 0x1C / 255, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let elapsed = (uptime() - startedAt).truncatingRemainder(dividingBy: Self.cycleSeconds)
    let barHeight = max(1, height / 20)
    let barTop: Int
    if elapsed < Self.motionSeconds {
      barTop = Int(elapsed / Self.motionSeconds * Double(height)) % height
      context.setFillColor(red: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF2 / 255, alpha: 1)
    } else {
      barTop = (height - barHeight) / 2
      context.setFillColor(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255, alpha: 1)
    }
    context.fill(CGRect(x: 0, y: height - barTop - barHeight, width: width, height: barHeight))  // origin bottom-left
    guard let image = context.makeImage() else {
      completion(.failure(helperError("test pattern: could not create a \(width)x\(height) image")))
      return
    }
    completion(.success(image))
  }
}

/// Snapshot mode: takes one picture at a time from `source`, never overlapping. The next
/// capture starts only after the previous picture was captured, compared and (when it
/// changed) encoded and written, and is due 1/fps after the previous one was due (a fixed
/// timeline, like a repeating timer, so a late timer does not lower the rate; when a capture
/// takes longer than 1/fps the next one starts right away and the timeline restarts).
/// A picture identical to the last frame sent is not encoded again; it counts as an idle
/// report, so the encoder re-sends the last frame about once per second instead.
final class SnapshotLoop: @unchecked Sendable {
  /// A hash of a picture's pixel rows (row padding excluded): cheap, and enough to tell
  /// whether anything on screen changed.
  private struct Fingerprint: Equatable {
    var width: Int
    var height: Int
    var hash: Int

    /// nil when the pixels cannot be read (the picture then always counts as changed).
    init?(_ image: CGImage) {
      guard let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return nil }
      let rowBytes = image.width * image.bitsPerPixel / 8
      let stride = image.bytesPerRow
      guard image.height > 0, rowBytes > 0, stride >= rowBytes,
        CFDataGetLength(data) >= stride * (image.height - 1) + rowBytes
      else { return nil }
      var hasher = Hasher()
      for row in 0..<image.height {
        hasher.combine(bytes: UnsafeRawBufferPointer(start: bytes + row * stride, count: rowBytes))
      }
      width = image.width
      height = image.height
      hash = hasher.finalize()
    }
  }

  private let queue = DispatchQueue(label: "iphone-ai-capture.snapshots", qos: .userInteractive)
  /// Starts the next capture (a timer with a small leeway; asyncAfter allows a tenth of the delay).
  private let timer: DispatchSourceTimer
  private let encoder: FrameEncoder
  /// Called on the loop's queue right before the first picture is handed to the encoder.
  private let onFirstPicture: (Geometry) -> Void
  /// Called on the loop's queue when a capture failed or timed out; the loop has stopped.
  private let onFailure: (SnapshotLoop, Error) -> Void

  // Only touched on `queue`.
  private var source: SnapshotSource
  private var geometry: Geometry
  private var interval: TimeInterval
  /// When the current capture was due (uptime).
  private var due: TimeInterval = 0
  private var running = false
  private var stopped = false
  private var captures = 0
  /// Number of the capture in flight (0: none).
  private var inFlight = 0
  private var announced = false
  private var lastSent: Fingerprint?

  init(
    source: SnapshotSource, geometry: Geometry, fps: Int, encoder: FrameEncoder,
    onFirstPicture: @escaping (Geometry) -> Void, onFailure: @escaping (SnapshotLoop, Error) -> Void
  ) {
    self.source = source
    self.geometry = geometry
    self.interval = 1 / Double(fps)
    self.encoder = encoder
    self.onFirstPicture = onFirstPicture
    self.onFailure = onFailure
    timer = DispatchSource.makeTimerSource(queue: queue)
    timer.setEventHandler { [weak self] in self?.captureNext() }
    timer.resume()  // no deadline yet: fires only once scheduled
  }

  func start() {
    queue.async { [self] in
      guard !running, !stopped else { return }
      running = true
      due = uptime()
      captureNext()
    }
  }

  /// Final: a stopped loop never captures again (a capture in flight is ignored).
  func stop() {
    queue.async { [self] in halt() }
  }

  /// New output size or frame rate, and a new source when the window's filter was refreshed.
  /// Applies from the next capture on.
  func update(geometry: Geometry, fps: Int, source: SnapshotSource?) {
    queue.async { [self] in
      if geometry != self.geometry { lastSent = nil }
      self.geometry = geometry
      interval = 1 / Double(fps)
      if let source { self.source = source }
    }
  }

  private func captureNext() {
    guard running else { return }
    captures += 1
    let number = captures
    inFlight = number
    let geometry = self.geometry
    let capturedAt = epochMilliseconds()
    source.capture(geometry) { [self] result in
      queue.async { [self] in finished(number, result, geometry: geometry, capturedAt: capturedAt) }
    }
    queue.asyncAfter(deadline: .now() + snapshotTimeout) { [self] in
      guard running, inFlight == number else { return }
      fail(helperError("a screenshot did not finish within \(Int(snapshotTimeout)) s"))
    }
  }

  private func finished(_ number: Int, _ result: Result<CGImage, Error>, geometry: Geometry, capturedAt: Int64) {
    guard running, inFlight == number else { return }  // stopped, or abandoned after the timeout
    inFlight = 0
    let image: CGImage
    switch result {
    case .failure(let error):
      fail(error)
      return
    case .success(let picture):
      image = picture
    }
    let fingerprint = Fingerprint(image)
    if let fingerprint, fingerprint == lastSent {
      encoder.noteIdle(from: self)
      scheduleNext()
      return
    }
    if !announced {
      announced = true
      onFirstPicture(geometry)
    }
    encoder.submit(image, capturedAt: capturedAt, from: self) { [self] sent in
      queue.async { [self] in
        // Not sent: the encoder still holds (and repeats) the previous frame.
        if sent { lastSent = fingerprint }
        scheduleNext()
      }
    }
  }

  private func scheduleNext() {
    guard running else { return }
    let now = uptime()
    due = max(due + interval, now)
    timer.schedule(deadline: .now() + (due - now), repeating: .never, leeway: .milliseconds(1))
  }

  private func halt() {
    running = false
    stopped = true
    inFlight = 0
    timer.cancel()
  }

  private func fail(_ error: Error) {
    halt()
    onFailure(self, error)
  }
}

// MARK: - Capture controller

/// Finds the window, runs one snapshot loop (or, in stream mode, one SCStream) for it and
/// follows size changes, closed and reopened windows. All state lives on `queue`.
final class CaptureController: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
  let mode: CaptureMode
  private let output: Output
  private let encoder: FrameEncoder
  private let queue = DispatchQueue(label: "iphone-ai-capture.control")
  private let sampleQueue = DispatchQueue(label: "iphone-ai-capture.samples", qos: .userInteractive)

  private var options: Options
  private var timer: DispatchSourceTimer?
  /// Stream mode: the running SCStream.
  private var stream: SCStream?
  /// Snapshot mode and the test pattern: the running capture loop.
  private var snapshots: SnapshotLoop?
  private var captureWindow: CGWindowID = 0
  /// Window frame (points) and backing scale the current configuration was built for.
  private var captureFrame: CGRect = .zero
  private var captureScale: CGFloat = 0
  private var geometry: Geometry?
  /// Code of the "waiting" status last reported ("no_window" / "window_hidden"); nil once capturing.
  private var reportedWaiting: String?
  private var lookupGeneration = 0
  private var lookupStartedAt: TimeInterval?
  private var lastLookupError: String?
  /// A capture failure is reported once the next lookup shows the window still exists
  /// (a closed window, or in snapshot mode one that is not on screen, is "waiting", not an error).
  private var pendingFailure: String?
  private var consecutiveFailures = 0
  private var stopping = false
  private var exited = false

  private var capturing: Bool { stream != nil || snapshots != nil }

  init(options: Options, output: Output) {
    self.mode = options.mode
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
      "capturing \(options.testPattern ? "a test pattern" : options.bundleId) in \(mode) mode at up to "
        + "\(options.fps) fps, long edge <= \(options.maxLongEdge) px, JPEG quality \(options.quality)")
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
      if restream, capturing { reconfigure(frame: captureFrame, scale: captureScale) }
    }
  }

  /// Stops capturing and exits. Safe to call from any thread, any number of times.
  func stop(exitCode: Int32, reason: String) {
    scheduleForcedExit(exitCode)  // the control queue itself may be blocked on stdout
    queue.async { [self] in finish(exitCode: exitCode, reason: reason, announce: true) }
  }

  /// The snapshot loop with the synthetic source instead of window screenshots; follows
  /// `config` like a window (`window` when the output size changes).
  private func startTestPattern() {
    captureFrame = TestPatternSource.windowFrame
    captureScale = TestPatternSource.scale
    let geometry = Geometry(frame: captureFrame, scale: captureScale, maxLongEdge: options.maxLongEdge)
    log(
      "test pattern: \(geometry.ptW)x\(geometry.ptH) pt -> \(geometry.pxW)x\(geometry.pxH) px, "
        + "up to \(options.fps) fps; ScreenCaptureKit is not used")
    startSnapshots(source: TestPatternSource(), geometry: geometry, message: "Test pattern (no screen capture).")
  }

  /// Runs a snapshot loop; "started" is reported with its first picture.
  private func startSnapshots(source: SnapshotSource, geometry: Geometry, message: String? = nil) {
    let output = self.output
    let loop = SnapshotLoop(
      source: source, geometry: geometry, fps: options.fps, encoder: encoder,
      onFirstPicture: { [weak self] geometry in
        // Written right away (not via `queue`), so "started" precedes the first frame.
        var fields = geometry.fields
        if let message { fields["message"] = message }
        output.status("started", fields)
        guard let self else { return }
        self.queue.async { self.reportedWaiting = nil }
      },
      onFailure: { [weak self] loop, error in
        guard let self else { return }
        self.queue.async {
          guard self.snapshots === loop, !self.stopping else { return }
          self.captureFailed(error, during: "snapshot")
        }
      })
    snapshots = loop
    self.geometry = geometry
    encoder.begin(source: loop, geometry: geometry)
    loop.start()
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
      if capturing {
        log("the window is gone; waiting for it to come back")
        tearDown()
      }
      if reportedWaiting != "no_window" {
        reportedWaiting = "no_window"
        log("no \(options.bundleId) window; checking again every \(Int(windowCheckInterval)) s")
        output.status(
          "waiting",
          ["code": "no_window", "message": "Waiting for the iPhone Mirroring window (\(options.bundleId))."])
      }
      return
    }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let scale = CGFloat(filter.pointPixelScale)
    if capturing, captureWindow == window.windowID {
      if Int(window.frame.width) != Int(captureFrame.width) || Int(window.frame.height) != Int(captureFrame.height)
        || scale != captureScale
      {
        reconfigure(frame: window.frame, scale: scale, filter: filter)
      }
      return
    }
    if capturing {
      log("the window changed (id \(captureWindow) -> \(window.windowID)); restarting the capture")
      tearDown()
    }
    if let failure = pendingFailure {
      pendingFailure = nil
      if mode == .snapshot, !window.isOnScreen || reportedWaiting == "window_hidden" {
        // Hidden (Cmd-H), minimized or on another Space: a screenshot of such a window can fail
        // until it is shown again. That is waiting, not a failing capture: retried every second
        // without counting, including the attempt still pending when the window is shown again.
        if window.isOnScreen {
          reportedWaiting = nil  // shown again: from now on a failure counts
        } else if reportedWaiting != "window_hidden" {
          reportedWaiting = "window_hidden"
          log("the window is not on screen and cannot be captured; retrying every \(Int(windowCheckInterval)) s")
          output.status(
            "waiting",
            [
              "code": "window_hidden",
              "message":
                "iPhone Mirroring is hidden, minimized or on another Space; show its window to resume the live view.",
            ])
        }
      } else {
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
    }
    switch mode {
    case .snapshot:
      let geometry = Geometry(frame: window.frame, scale: scale, maxLongEdge: options.maxLongEdge)
      captureWindow = window.windowID
      captureFrame = window.frame
      captureScale = scale
      if reportedWaiting != "window_hidden" {  // not again every second while hidden
        log(
          "starting snapshots of window \(window.windowID): \(geometry.ptW)x\(geometry.ptH) pt @\(scale)x -> "
            + "\(geometry.pxW)x\(geometry.pxH) px, up to \(options.fps) fps")
      }
      startSnapshots(source: WindowSnapshotSource(filter: filter), geometry: geometry)
    case .stream:
      startStream(window: window, filter: filter, scale: scale)
    }
  }

  // MARK: Capture lifecycle

  private func makeConfiguration(_ geometry: Geometry) -> SCStreamConfiguration {
    let configuration = captureConfiguration(geometry)
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
    configuration.queueDepth = 4
    return configuration
  }

  /// Stream mode only (see CaptureMode.stream for why the app never uses it).
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
    captureWindow = window.windowID
    captureFrame = window.frame
    captureScale = scale
    encoder.begin(source: stream, geometry: geometry)
    log(
      "starting capture of window \(window.windowID): \(geometry.ptW)x\(geometry.ptH) pt @\(scale)x -> "
        + "\(geometry.pxW)x\(geometry.pxH) px, \(options.fps) fps")
    stream.startCapture { [weak self] error in
      guard let self else { return }
      self.queue.async {
        guard self.stream === stream, !self.stopping else { return }
        if let error {
          self.captureFailed(error, during: "start")
          return
        }
        self.reportedWaiting = nil
        self.output.status("started", geometry.fields)
      }
    }
  }

  /// Window resized / moved to a display with another scale, or fps / maxLongEdge changed.
  /// `filter` is the window's fresh content filter (nil when only the config changed).
  private func reconfigure(frame: CGRect, scale: CGFloat, filter: SCContentFilter? = nil) {
    guard capturing else { return }
    let geometry = Geometry(frame: frame, scale: scale, maxLongEdge: options.maxLongEdge)
    let changed = geometry != self.geometry
    captureFrame = frame
    captureScale = scale
    self.geometry = geometry
    encoder.update(geometry: geometry)
    if changed {
      log("window is now \(geometry.ptW)x\(geometry.ptH) pt @\(scale)x -> \(geometry.pxW)x\(geometry.pxH) px")
    }
    if let snapshots {
      snapshots.update(geometry: geometry, fps: options.fps, source: filter.map { WindowSnapshotSource(filter: $0) })
      if changed { output.status("window", geometry.fields) }
      return
    }
    guard let stream else { return }
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

  private func captureFailed(_ error: Error, during phase: String) {
    tearDown()
    if options.testPattern {
      // No window lookup restarts it; cannot happen short of running out of memory.
      log("test pattern failed: \(describe(error))")
      output.status("error", ["code": "stream_failed", "message": "The test pattern failed: \(describe(error))"])
      finish(exitCode: ExitCode.streamFailed, reason: "test pattern failed", announce: false)
      return
    }
    if isPermissionError(error) || (mode == .snapshot && !CGPreflightScreenCaptureAccess()) {
      permissionDenied("\(phase): \(describe(error))")
      return
    }
    // Reported (or turned into "waiting") by the next window check.
    pendingFailure = "capture \(phase) failed: \(describe(error))"
    if reportedWaiting != "window_hidden" { log(pendingFailure!) }  // not again every second while hidden
  }

  private func tearDown() {
    guard capturing else { return }
    geometry = nil
    captureWindow = 0
    encoder.end()
    if let snapshots {
      self.snapshots = nil
      snapshots.stop()
    }
    if let stream {
      self.stream = nil
      try? stream.removeStreamOutput(self, type: .screen)
      stream.stopCapture { _ in }  // already stopped after a failure: the error is expected
    }
  }

  private func permissionDenied(_ detail: String) {
    log("Screen Recording permission denied (\(detail))")
    output.status("error", ["code": "permission", "message": permissionMessage])
    finish(exitCode: ExitCode.permission, reason: "Screen Recording permission denied", announce: false)
  }

  /// Stops the capture, optionally announces "stopped", flushes stdout and exits.
  private func finish(exitCode: Int32, reason: String, announce: Bool) {
    guard !stopping else { return }
    stopping = true
    scheduleForcedExit(exitCode)
    timer?.cancel()
    timer = nil
    snapshots?.stop()
    snapshots = nil
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
      captureFailed(error, during: "stream")
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
    let mode = controller.mode
    let fps = jsonInteger(object["fps"]).map { clamped($0, to: mode.fpsRange, name: "fps", note: " in \(mode) mode") }
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

// MARK: - Background-only process

/// Checks the process in with LaunchServices as a background-only app, on the main thread,
/// before anything else creates NSApplication. Otherwise ScreenCaptureKit (ReplayKit) creates
/// it lazily on a background queue, which checks in with the main bundle's Info.plist: inside
/// the app that is iPhone AI.app, a regular app, and the helper became a second "iPhone AI"
/// with its own Dock icon that could even become frontmost. The Info.plist embedded at link
/// time (capture/Info.plist in __TEXT,__info_plist) declares LSBackgroundOnly; it is in effect
/// only while this executable's name does not end with the app's CFBundleExecutable
/// ("iphone-ai"). The prohibited activation policy is the fallback when it is not.
@MainActor
func becomeBackgroundOnly() {
  let declared = Bundle.main.object(forInfoDictionaryKey: "LSBackgroundOnly")
  let backgroundOnly =
    (declared as? NSNumber)?.boolValue
    ?? (declared as? String).map { ["1", "yes", "true"].contains($0.lowercased()) } ?? false
  if !backgroundOnly {
    log(
      "warning: \(backgroundOnlyWarning) (main bundle \(Bundle.main.bundleIdentifier ?? "none") does not "
        + "declare LSBackgroundOnly); falling back to the prohibited activation policy")
  }
  let app = NSApplication.shared
  if app.activationPolicy() != .prohibited {
    _ = app.setActivationPolicy(.prohibited)
  }
}

// MARK: - Entry point

@main
enum CaptureMain {
  static func main() {
    // A closed stdout must surface as EPIPE from write(2), not kill the process.
    signal(SIGPIPE, SIG_IGN)
    let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
    // After the options, so --help / --version never connect to the window server.
    MainActor.assumeIsolated { becomeBackgroundOnly() }
    let output = Output()

    // Checked before touching ScreenCaptureKit, which could otherwise show a permission prompt.
    guard options.testPattern || CGPreflightScreenCaptureAccess() else {
      log("Screen Recording permission is not granted to this process (or the app that launched it)")
      output.status("error", ["code": "permission", "message": permissionMessage])
      output.close()
      terminate(ExitCode.permission)
    }

    // A windowless background-only app is a candidate for App Nap, which would throttle the
    // timers that pace the screenshots and repeat idle frames (the backend expects a frame at
    // least every 2 s). Held until the process exits.
    let activity = ProcessInfo.processInfo.beginActivity(
      options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "iPhone AI live view")
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
    withExtendedLifetime((signalSources, activity)) { dispatchMain() }
  }
}
