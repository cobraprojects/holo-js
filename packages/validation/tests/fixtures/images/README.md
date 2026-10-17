These small fixtures are real encoded images produced with sharp (libvips), plus damaged copies of them.

- `valid.png`, `valid.jpeg`, `valid.avif`, `valid.tiff`: 48x32 noise images.
- `animated.gif`, `animated.webp`: three 24x24 frames.
- `corrupted-pixels.png`: `valid.png` with every 97th byte of its IDAT pixel data inverted, so its signature and header are intact but its compressed pixel data and CRC are broken.
- `truncated.png`, `truncated.jpeg`: the first 60% of a valid file.
- `truncated-animated.gif`, `truncated-animated.webp`: the first 75% of the animated files.
- `oversized-pixels.png`: a 6400x6400 black PNG (40,960,000 decoded pixels).
- `too-many-frames.gif`: 1,001 alternating 1x1 frames.
- `scripted.svg`: an SVG containing a script.
- `disguised-avatar.png`: XHTML with a script, saved under an image name.
- `bitmap.bmp`: a 2x2 BMP, a raster format that image validation does not decode.
