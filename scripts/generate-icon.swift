// Renders the iPhone AI app icon as a 1024×1024 PNG with CoreGraphics.
//
//   /usr/bin/swift scripts/generate-icon.swift <output.png>
//
// Layout follows the macOS icon grid: an 824 pt continuous-corner square
// (superellipse, ~22% corner radius) centred in a 1024 canvas with a soft drop
// shadow; inside, a stylised iPhone outline with a blue→purple glowing
// gradient and an AI sparkle. Normally run through scripts/generate-icon.mjs.

import CoreGraphics
import CoreImage
import Foundation
import ImageIO

let canvas = 1024
let side = CGFloat(canvas)

guard CommandLine.arguments.count >= 2 else {
  FileHandle.standardError.write("usage: generate-icon.swift <output.png>\n".data(using: .utf8)!)
  exit(2)
}
let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    colorSpace: colorSpace,
    components: [
      CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, alpha,
    ])!
}

func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
  CGGradient(
    colorsSpace: colorSpace, colors: stops.map { $0.1 } as CFArray, locations: stops.map { $0.0 })!
}

/// A transparent canvas with a top-left origin (y grows downwards).
func makeContext() -> CGContext {
  let ctx = CGContext(
    data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.translateBy(x: 0, y: side)
  ctx.scaleBy(x: 1, y: -1)
  ctx.setShouldAntialias(true)
  ctx.interpolationQuality = .high
  return ctx
}

func render(_ draw: (CGContext) -> Void) -> CGImage {
  let ctx = makeContext()
  draw(ctx)
  return ctx.makeImage()!
}

/// Draws a full-canvas image produced by `render` (undoing the flip, which images ignore).
func composite(_ image: CGImage, into ctx: CGContext, alpha: CGFloat = 1) {
  ctx.saveGState()
  ctx.translateBy(x: 0, y: side)
  ctx.scaleBy(x: 1, y: -1)
  ctx.setAlpha(alpha)
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
  ctx.restoreGState()
}

let ciContext = CIContext(options: [.workingColorSpace: colorSpace, .outputColorSpace: colorSpace])

func blurred(_ image: CGImage, radius: Double) -> CGImage {
  let input = CIImage(cgImage: image)
  let output = input.clampedToExtent().applyingGaussianBlur(sigma: radius).cropped(to: input.extent)
  return ciContext.createCGImage(output, from: input.extent)!
}

/// Superellipse |x/a|^n + |y/b|^n = 1 — close to Apple's continuous-corner icon shape.
func squircle(_ rect: CGRect, exponent n: CGFloat = 5) -> CGPath {
  let path = CGMutablePath()
  let steps = 1440
  for i in 0...steps {
    let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
    let c = cos(t)
    let s = sin(t)
    let x = rect.midX + rect.width / 2 * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n)
    let y = rect.midY + rect.height / 2 * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
    if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
  }
  path.closeSubpath()
  return path
}

/// Four-pointed sparkle with concave sides.
func sparkle(center: CGPoint, radius r: CGFloat, waist: CGFloat = 0.16) -> CGPath {
  let path = CGMutablePath()
  let k = r * waist
  let top = CGPoint(x: center.x, y: center.y - r)
  let right = CGPoint(x: center.x + r, y: center.y)
  let bottom = CGPoint(x: center.x, y: center.y + r)
  let left = CGPoint(x: center.x - r, y: center.y)
  path.move(to: top)
  path.addQuadCurve(to: right, control: CGPoint(x: center.x + k, y: center.y - k))
  path.addQuadCurve(to: bottom, control: CGPoint(x: center.x + k, y: center.y + k))
  path.addQuadCurve(to: left, control: CGPoint(x: center.x - k, y: center.y + k))
  path.addQuadCurve(to: top, control: CGPoint(x: center.x - k, y: center.y - k))
  path.closeSubpath()
  return path
}

// MARK: - Geometry

let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = squircle(tile)

let phone = CGRect(x: 357, y: 232, width: 310, height: 572)
let phonePath = CGPath(roundedRect: phone, cornerWidth: 74, cornerHeight: 74, transform: nil)
let strokeWidth: CGFloat = 26
let island = CGRect(x: phone.midX - 48, y: phone.minY + 34, width: 96, height: 28)
let buttons: [CGRect] = [
  CGRect(x: phone.minX - strokeWidth / 2 - 12, y: 352, width: 10, height: 44),
  CGRect(x: phone.minX - strokeWidth / 2 - 12, y: 418, width: 10, height: 74),
  CGRect(x: phone.maxX + strokeWidth / 2 + 2, y: 392, width: 10, height: 104),
]
let mainSpark = sparkle(center: CGPoint(x: phone.midX, y: 520), radius: 118)
let smallSpark = sparkle(center: CGPoint(x: phone.midX + 84, y: 382), radius: 40)

let edgeGradient = gradient([(0, rgb(0x38BDF8)), (0.48, rgb(0x6366F1)), (1, rgb(0xA855F7))])
let edgeStart = CGPoint(x: phone.minX, y: phone.minY)
let edgeEnd = CGPoint(x: phone.maxX, y: phone.maxY)

/// The phone outline, side buttons and island, filled with the edge gradient.
func drawPhoneEdge(_ ctx: CGContext) {
  ctx.saveGState()
  ctx.addPath(phonePath)
  ctx.setLineWidth(strokeWidth)
  ctx.replacePathWithStrokedPath()
  for button in buttons {
    ctx.addPath(CGPath(roundedRect: button, cornerWidth: 5, cornerHeight: 5, transform: nil))
  }
  ctx.addPath(CGPath(roundedRect: island, cornerWidth: 14, cornerHeight: 14, transform: nil))
  ctx.clip()
  ctx.drawLinearGradient(edgeGradient, start: edgeStart, end: edgeEnd, options: [])
  ctx.restoreGState()
}

func drawSparkles(_ ctx: CGContext) {
  let fill = gradient([(0, rgb(0xFFFFFF)), (1, rgb(0xE9D5FF))])
  for (path, alpha) in [(mainSpark, CGFloat(1)), (smallSpark, CGFloat(0.85))] {
    ctx.saveGState()
    ctx.setAlpha(alpha)
    ctx.addPath(path)
    ctx.clip()
    let box = path.boundingBox
    ctx.drawLinearGradient(
      fill, start: CGPoint(x: box.midX, y: box.minY), end: CGPoint(x: box.midX, y: box.maxY), options: [])
    ctx.restoreGState()
  }
}

// MARK: - Layers

let edgeLayer = render(drawPhoneEdge)
let sparkLayer = render(drawSparkles)
let glowWide = blurred(edgeLayer, radius: 34)
let glowTight = blurred(edgeLayer, radius: 10)
let sparkGlow = blurred(render { ctx in
  ctx.addPath(mainSpark)
  ctx.addPath(smallSpark)
  ctx.setFillColor(rgb(0xC4B5FD))
  ctx.fillPath()
}, radius: 22)

let ctx = makeContext()

// Tile with the standard soft drop shadow (offset is in device space: negative y = down).
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: rgb(0x000000, 0.45))
ctx.addPath(tilePath)
ctx.setFillColor(rgb(0x1A1C22))
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(tilePath)
ctx.clip()

// Charcoal body, lighter at the top.
ctx.drawLinearGradient(
  gradient([(0, rgb(0x343842)), (0.55, rgb(0x1F2229)), (1, rgb(0x14161B))]),
  start: CGPoint(x: 512, y: tile.minY), end: CGPoint(x: 512, y: tile.maxY), options: [])

// Ambient blue/purple bloom behind the phone.
ctx.drawRadialGradient(
  gradient([(0, rgb(0x6366F1, 0.30)), (0.6, rgb(0x7C3AED, 0.10)), (1, rgb(0x7C3AED, 0))]),
  startCenter: CGPoint(x: 512, y: 520), startRadius: 0, endCenter: CGPoint(x: 512, y: 520), endRadius: 430,
  options: [])

// Screen: a deep tinted fill inside the outline.
ctx.saveGState()
ctx.addPath(phonePath)
ctx.clip()
ctx.drawLinearGradient(
  gradient([(0, rgb(0x1B2135)), (1, rgb(0x161325))]),
  start: CGPoint(x: 512, y: phone.minY), end: CGPoint(x: 512, y: phone.maxY), options: [])
ctx.drawRadialGradient(
  gradient([(0, rgb(0x8B5CF6, 0.38)), (1, rgb(0x8B5CF6, 0))]),
  startCenter: CGPoint(x: 512, y: 520), startRadius: 0, endCenter: CGPoint(x: 512, y: 520), endRadius: 190,
  options: [])
ctx.restoreGState()

// Glow, then the crisp edge on top.
composite(glowWide, into: ctx, alpha: 0.95)
composite(glowWide, into: ctx, alpha: 0.55)
composite(glowTight, into: ctx, alpha: 0.9)
composite(edgeLayer, into: ctx)

composite(sparkGlow, into: ctx, alpha: 0.9)
composite(sparkLayer, into: ctx)

// Hairline highlight along the top edge of the tile.
ctx.addPath(tilePath)
ctx.setLineWidth(3)
ctx.replacePathWithStrokedPath()
ctx.clip()
ctx.drawLinearGradient(
  gradient([(0, rgb(0xFFFFFF, 0.16)), (0.4, rgb(0xFFFFFF, 0.03)), (1, rgb(0xFFFFFF, 0))]),
  start: CGPoint(x: 512, y: tile.minY), end: CGPoint(x: 512, y: tile.maxY), options: [])
ctx.restoreGState()

// MARK: - Write PNG

guard let image = ctx.makeImage(),
  let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.png" as CFString, 1, nil)
else {
  FileHandle.standardError.write("could not create \(outputURL.path)\n".data(using: .utf8)!)
  exit(1)
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else {
  FileHandle.standardError.write("could not write \(outputURL.path)\n".data(using: .utf8)!)
  exit(1)
}
print("wrote \(outputURL.path) (\(canvas)x\(canvas))")
