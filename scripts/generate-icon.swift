// Renders the iPhone AI app icon (1024×1024 PNG) from the brand logo.
//
//   /usr/bin/swift scripts/generate-icon.swift <logo.png> <output.png>
//
// Layout follows the macOS icon grid: an 824 pt continuous-corner square
// (superellipse) centred in a 1024 canvas with a soft drop shadow. The tile is
// a light, slightly cool gradient and carries the blue ribbon-infinity logo
// (assets/brand/logo.png), upscaled with Lanczos resampling plus light
// sharpening, with a soft blue glow beneath it. Normally run through
// scripts/generate-icon.mjs.

import CoreGraphics
import CoreImage
import Foundation
import ImageIO

let canvas = 1024
let side = CGFloat(canvas)

guard CommandLine.arguments.count >= 3 else {
  FileHandle.standardError.write("usage: generate-icon.swift <logo.png> <output.png>\n".data(using: .utf8)!)
  exit(2)
}
let logoURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(
    colorSpace: colorSpace,
    components: [
      CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, alpha,
    ])!
}

func gradient(_ stops: [(CGFloat, CGColor)]) -> CGGradient {
  CGGradient(colorsSpace: colorSpace, colors: stops.map { $0.1 } as CFArray, locations: stops.map { $0.0 })!
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

/// Draws an image into a rect given in top-left coordinates (images ignore the flip).
func draw(_ image: CGImage, in rect: CGRect, into ctx: CGContext, alpha: CGFloat = 1) {
  ctx.saveGState()
  ctx.setAlpha(alpha)
  ctx.translateBy(x: rect.minX, y: rect.maxY)
  ctx.scaleBy(x: 1, y: -1)
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: rect.width, height: rect.height))
  ctx.restoreGState()
}

let ciContext = CIContext(options: [.workingColorSpace: colorSpace, .outputColorSpace: colorSpace])

func blurred(_ image: CGImage, radius: Double) -> CGImage {
  let input = CIImage(cgImage: image)
  let output = input.clampedToExtent().applyingGaussianBlur(sigma: radius).cropped(to: input.extent)
  return ciContext.createCGImage(output, from: input.extent)!
}

/// Lanczos upscale + gentle unsharp mask, so a small source logo stays crisp.
func upscaled(_ image: CGImage, toWidth width: CGFloat) -> CGImage {
  let input = CIImage(cgImage: image)
  let scale = width / CGFloat(image.width)
  let lanczos = CIFilter(name: "CILanczosScaleTransform")!
  lanczos.setValue(input, forKey: kCIInputImageKey)
  lanczos.setValue(scale, forKey: kCIInputScaleKey)
  lanczos.setValue(1.0, forKey: kCIInputAspectRatioKey)
  let sharpen = CIFilter(name: "CIUnsharpMask")!
  sharpen.setValue(lanczos.outputImage!, forKey: kCIInputImageKey)
  sharpen.setValue(1.6 * scale, forKey: kCIInputRadiusKey)
  sharpen.setValue(0.35, forKey: kCIInputIntensityKey)
  let output = sharpen.outputImage!
  let extent = CGRect(x: 0, y: 0, width: (CGFloat(image.width) * scale).rounded(), height: (CGFloat(image.height) * scale).rounded())
  return ciContext.createCGImage(output, from: extent)!
}

/// Tints the logo's alpha mask with one colour (used for the glow).
func silhouette(_ image: CGImage, color: CGColor) -> CGImage {
  let ctx = CGContext(
    data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
  ctx.clip(to: rect, mask: image)
  ctx.setFillColor(color)
  ctx.fill(rect)
  return ctx.makeImage()!
}

/// Continuous-corner rounded square (superellipse), like macOS icon tiles.
func squircle(_ rect: CGRect, exponent n: CGFloat = 5) -> CGPath {
  let path = CGMutablePath()
  let a = rect.width / 2
  let b = rect.height / 2
  let steps = 720
  for i in 0...steps {
    let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
    let c = cos(t)
    let s = sin(t)
    let x = rect.midX + a * (c < 0 ? -1 : 1) * pow(abs(c), 2 / n)
    let y = rect.midY + b * (s < 0 ? -1 : 1) * pow(abs(s), 2 / n)
    if i == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
  }
  path.closeSubpath()
  return path
}

guard
  let source = CGImageSourceCreateWithURL(logoURL as CFURL, nil),
  let logo = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write("could not read \(logoURL.path)\n".data(using: .utf8)!)
  exit(1)
}

let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let tilePath = squircle(tile)

// Logo: ~80% of the tile width, optically centred (a touch above centre).
let logoWidth: CGFloat = 664
let bigLogo = upscaled(logo, toWidth: logoWidth)
let logoHeight = CGFloat(bigLogo.height)
let logoRect = CGRect(x: (side - logoWidth) / 2, y: tile.midY - logoHeight / 2 - 8, width: logoWidth, height: logoHeight)

// 1. Tile drop shadow.
let shadow = blurred(render { ctx in
  ctx.addPath(squircle(tile.offsetBy(dx: 0, dy: 14)))
  ctx.setFillColor(rgb(0x0B1220, 0.42))
  ctx.fillPath()
}, radius: 18)

// 2. Glow under the logo.
let glowSource = render { ctx in
  draw(silhouette(bigLogo, color: rgb(0x2F6BEA, 0.55)), in: logoRect.offsetBy(dx: 0, dy: 22), into: ctx)
}
let glow = blurred(glowSource, radius: 26)

let icon = render { ctx in
  draw(shadow, in: CGRect(x: 0, y: 0, width: side, height: side), into: ctx)

  // Tile body: light, slightly cool vertical gradient.
  ctx.saveGState()
  ctx.addPath(tilePath)
  ctx.clip()
  ctx.drawLinearGradient(
    gradient([(0, rgb(0xFFFFFF)), (0.55, rgb(0xF3F6FB)), (1, rgb(0xE3EAF5))]),
    start: CGPoint(x: tile.midX, y: tile.minY), end: CGPoint(x: tile.midX, y: tile.maxY), options: [])
  // Soft top sheen.
  ctx.drawRadialGradient(
    gradient([(0, rgb(0xFFFFFF, 0.9)), (1, rgb(0xFFFFFF, 0))]),
    startCenter: CGPoint(x: tile.midX, y: tile.minY + 40), startRadius: 0,
    endCenter: CGPoint(x: tile.midX, y: tile.minY + 40), endRadius: 520, options: [])
  draw(glow, in: CGRect(x: 0, y: 0, width: side, height: side), into: ctx, alpha: 0.6)
  ctx.restoreGState()

  // Hairline edge for definition on light backgrounds.
  ctx.addPath(tilePath)
  ctx.setStrokeColor(rgb(0x9AAAC4, 0.35))
  ctx.setLineWidth(2)
  ctx.strokePath()

  draw(bigLogo, in: logoRect, into: ctx)
}

guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.png" as CFString, 1, nil) else {
  FileHandle.standardError.write("could not create \(outputURL.path)\n".data(using: .utf8)!)
  exit(1)
}
CGImageDestinationAddImage(destination, icon, nil)
guard CGImageDestinationFinalize(destination) else {
  FileHandle.standardError.write("could not write \(outputURL.path)\n".data(using: .utf8)!)
  exit(1)
}
print("wrote \(outputURL.path) (\(canvas)×\(canvas)) from \(logoURL.lastPathComponent) (\(logo.width)×\(logo.height))")
