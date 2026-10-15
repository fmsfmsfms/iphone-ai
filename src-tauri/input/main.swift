// iphone-ai-input — iPhone AI's own swipe ("glide") for the iPhone Mirroring window.
//
// Mirroir's `swipe` either crawls (slow drag) or flicks with a ~1.4 s momentum
// tail it waits out, and iOS only snaps a paging feed (TikTok, Reels, Shorts)
// to the nearest item when a scroll ends with a slow lift. This helper posts
// one trackpad-style scroll gesture whose velocity eases out to a stop before
// the lift: the content moves quickly, the lift is slow, and iOS snaps at once
// (measured on a real iPhone: 6 of 6 pages, ≈0.35 s per gesture).
//
// The backend runs it once per swipe, after its own checks (control mode,
// approvals, the task's control lease, STOP, paused/geometry checks). It never
// taps, types or clicks: it only posts scroll-wheel events, at the middle of the
// iPhone Mirroring window, and restores the pointer afterwards. SIGTERM (the
// emergency stop) ends the gesture with a lift and exits.
//
//   iphone-ai-input glide --dx <pt> --dy <pt> [--duration-ms 250] [--bundle-id com.apple.ScreenContinuity] [--dry-run]
//   iphone-ai-input --help | --version

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

let toolName = "iphone-ai-input"
let toolVersion = "1"
let usage = """
usage: \(toolName) glide --dx <pt> --dy <pt> [--duration-ms 250] [--bundle-id com.apple.ScreenContinuity] [--dry-run]
       \(toolName) --help | --version

  --dx/--dy      finger travel in window points (negative dy: finger up, next item)
  --duration-ms  gesture length, 80-1000 (default 250)
  --dry-run      print the planned frames as JSON; posts nothing and needs no permission

Prints one JSON line. Exit 0: done; 2: not done (not_trusted, no_window,
activation_failed); 3: interrupted mid-gesture; 64: bad arguments.
"""

/// Mirroir's scroll amplification: content moves about one point per point of finger travel.
let wheelPerPoint = 3.0
let frameMs = 8.0
/// Zero-delta frames before the lift (the finger rests, so the lift is slow).
let holdMs = 40.0
let easeExponent = 3.0

// MARK: - Output

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    }
}

func fail(_ code: String, _ message: String, exitCode: Int32 = 2) -> Never {
    emit(["ok": false, "error": code, "message": message])
    exit(exitCode)
}

func usageError(_ message: String) -> Never {
    FileHandle.standardError.write("\(toolName): \(message)\n\(usage)\n".data(using: .utf8)!)
    emit(["ok": false, "error": "bad_args", "message": message])
    exit(64)
}

// MARK: - Arguments

struct Options {
    var dx = 0.0
    var dy = 0.0
    var durationMs = 250.0
    var bundleID = "com.apple.ScreenContinuity"
    var dryRun = false
}

func parseOptions(_ argv: [String]) -> Options {
    if argv.contains("--help") || argv.contains("-h") {
        print(usage)
        exit(0)
    }
    if argv.contains("--version") {
        print("\(toolName) \(toolVersion)")
        exit(0)
    }
    guard argv.first == "glide" else { usageError("expected the glide command") }
    var options = Options()
    var sawDx = false, sawDy = false
    var i = 1
    func value() -> String {
        i += 1
        guard i < argv.count else { usageError("\(argv[i - 1]) needs a value") }
        return argv[i]
    }
    func number(_ text: String, _ name: String) -> Double {
        guard let n = Double(text), n.isFinite else { usageError("\(name) must be a number (got \(text))") }
        return n
    }
    while i < argv.count {
        let arg = argv[i]
        switch arg {
        case "--dx": options.dx = number(value(), "--dx"); sawDx = true
        case "--dy": options.dy = number(value(), "--dy"); sawDy = true
        case "--duration-ms": options.durationMs = number(value(), "--duration-ms")
        case "--bundle-id": options.bundleID = value()
        case "--dry-run": options.dryRun = true
        default: usageError("unknown option \(arg)")
        }
        i += 1
    }
    guard sawDx, sawDy else { usageError("--dx and --dy are required") }
    guard abs(options.dx) <= 4000, abs(options.dy) <= 4000, hypot(options.dx, options.dy) >= 1 else {
        usageError("the travel must be 1-4000 points")
    }
    options.durationMs = min(1000, max(80, options.durationMs))
    return options
}

// MARK: - Gesture plan

/// Per-frame wheel deltas (x, y) of an ease-out gesture; each axis sums exactly to its total.
func plan(_ options: Options) -> [(Int32, Int32)] {
    let totalX = (options.dx * wheelPerPoint).rounded()
    let totalY = (options.dy * wheelPerPoint).rounded()
    let frames = max(2, Int((options.durationMs / frameMs).rounded()))
    var sentX = 0.0, sentY = 0.0
    var steps: [(Int32, Int32)] = []
    for i in 1...frames {
        let t = Double(i) / Double(frames)
        let p = 1 - pow(1 - t, easeExponent)
        let x = (totalX * p).rounded() - sentX
        let y = (totalY * p).rounded() - sentY
        sentX += x
        sentY += y
        steps.append((Int32(x), Int32(y)))
    }
    return steps
}

// MARK: - Window and activation

func runningApp(_ bundleID: String) -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first
}

/// The app's largest on-screen normal window, in global display coordinates.
func targetWindow(pid: pid_t) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    var best: CGRect?
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
              (info[kCGWindowLayer as String] as? Int) == 0,
              let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict),
              bounds.width >= 100, bounds.height >= 100 else { continue }
        if best == nil || bounds.width * bounds.height > best!.width * best!.height { best = bounds }
    }
    return best
}

func frontmostBundleID() -> String? {
    // Let AppKit refresh its view of the active app.
    RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    return NSWorkspace.shared.frontmostApplication?.bundleIdentifier
}

/// Brings the app to the front (scroll gestures go to the active app). Returns whether it had to.
func activate(_ bundleID: String) -> Bool {
    if frontmostBundleID() == bundleID { return false }
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-b", bundleID]
    do {
        try open.run()
        open.waitUntilExit()
    } catch {
        fail("activation_failed", "could not bring \(bundleID) to the front: \(error.localizedDescription)")
    }
    let deadline = Date().addingTimeInterval(1.5)
    while frontmostBundleID() != bundleID {
        if Date() > deadline { fail("activation_failed", "\(bundleID) did not come to the front") }
        usleep(20_000)
    }
    usleep(300_000) // let the window server settle, as Mirroir does after a focus switch
    return true
}

// MARK: - Events

let isContinuousField = CGEventField(rawValue: 88)!   // kCGScrollWheelEventIsContinuous
let pointDeltaYField = CGEventField(rawValue: 96)!    // kCGScrollWheelEventPointDeltaAxis1
let pointDeltaXField = CGEventField(rawValue: 97)!    // kCGScrollWheelEventPointDeltaAxis2
let scrollPhaseField = CGEventField(rawValue: 99)!    // kCGScrollWheelEventScrollPhase
let momentumPhaseField = CGEventField(rawValue: 123)! // kCGScrollWheelEventMomentumPhase
let phaseMayBegin: Int64 = 128, phaseBegan: Int64 = 1, phaseChanged: Int64 = 2, phaseEnded: Int64 = 4

func postScroll(_ dx: Int32, _ dy: Int32, phase: Int64, at point: CGPoint) {
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
    event.location = point
    event.setIntegerValueField(isContinuousField, value: 1)
    event.setIntegerValueField(pointDeltaYField, value: Int64(dy))
    event.setIntegerValueField(pointDeltaXField, value: Int64(dx))
    event.setIntegerValueField(scrollPhaseField, value: phase)
    event.setIntegerValueField(momentumPhaseField, value: 0)
    event.post(tap: .cghidEventTap)
}

// SIGTERM / SIGINT: finish with a lift instead of leaving a gesture open.
var interrupted = false
let signalQueue = DispatchQueue(label: "signals")
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler { interrupted = true }
    source.resume()
    signalSources.append(source)
}

// MARK: - Main

let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
let steps = plan(options)
let totals = steps.reduce((0, 0)) { ($0.0 + Int($1.0), $0.1 + Int($1.1)) }

if options.dryRun {
    emit([
        "ok": true, "dryRun": true, "frames": steps.count, "frameMs": frameMs, "holdMs": holdMs,
        "wheel": [totals.0, totals.1], "deltas": steps.map { [Int($0.0), Int($0.1)] },
    ])
    exit(0)
}

guard AXIsProcessTrusted() else {
    fail("not_trusted", "iPhone AI does not have Accessibility permission (System Settings > Privacy & Security > Accessibility)")
}
guard let app = runningApp(options.bundleID) else { fail("no_window", "\(options.bundleID) is not running") }
let started = Date()
let activated = activate(options.bundleID)
guard let window = targetWindow(pid: app.processIdentifier) else { fail("no_window", "no on-screen \(options.bundleID) window") }
let centre = CGPoint(x: window.midX, y: window.midY)

let savedPointer = CGEvent(source: nil)?.location
CGWarpMouseCursorPosition(centre)
if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: centre, mouseButton: .left) {
    move.post(tap: .cghidEventTap)
}
usleep(50_000)
postScroll(0, 0, phase: phaseMayBegin, at: centre) // wakes iPhone Mirroring's scroll handler
usleep(100_000)

var posted = 0
for (index, step) in steps.enumerated() where !interrupted {
    postScroll(step.0, step.1, phase: index == 0 ? phaseBegan : phaseChanged, at: centre)
    posted += 1
    usleep(UInt32(frameMs * 1000))
}
if !interrupted {
    for _ in 0..<Int(holdMs / frameMs) {
        postScroll(0, 0, phase: phaseChanged, at: centre)
        usleep(UInt32(frameMs * 1000))
    }
}
postScroll(0, 0, phase: phaseEnded, at: centre) // the lift
usleep(16_000)
if let saved = savedPointer { CGWarpMouseCursorPosition(saved) }

let ms = Int(Date().timeIntervalSince(started) * 1000)
if interrupted {
    emit(["ok": false, "error": "interrupted", "message": "stopped after \(posted) of \(steps.count) frames", "ms": ms])
    exit(3)
}
emit([
    "ok": true, "ms": ms, "activated": activated, "frames": steps.count, "wheel": [totals.0, totals.1],
    "window": [Int(window.minX), Int(window.minY), Int(window.width), Int(window.height)],
])
