#!/bin/sh
# Rasterizes build/icon.svg into build/icon.png (1024x1024) and build/icon.icns.
# macOS only (AppKit renders the SVG; iconutil builds the .icns). Run from anywhere.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/render.swift" <<'SWIFT'
import AppKit
let args = CommandLine.arguments
let size = Int(args[3])!
guard let image = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else { exit(1) }
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: size, height: size)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
SWIFT

swift "$tmp/render.swift" icon.svg icon.png 1024

set_dir="$tmp/icon.iconset"
mkdir "$set_dir"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" icon.png --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" icon.png --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o icon.icns
echo "wrote build/icon.png and build/icon.icns"
