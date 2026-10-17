These tiny fixtures contain generated media, with no external recordings. Tests read the checked-in bytes and do not require FFmpeg.

Generated with FFmpeg 9.0.2 from this directory:

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a pcm_s16le sample.wav
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a libmp3lame sample.mp3
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a flac sample.flac
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a libopus sample.ogg
ffmpeg -f lavfi -i 'sine=frequency=440:duration=0.1' -c:a aac sample.m4a
ffmpeg -f lavfi -i 'color=c=red:s=16x16:r=10:d=0.1' -c:v libx264 sample.mp4
ffmpeg -f lavfi -i 'color=c=red:s=16x16:r=10:d=0.1' -c:v libvpx-vp9 sample.webm
ffmpeg -f lavfi -i 'color=c=red:s=16x16:r=10:d=0.1' -c:v mpeg4 sample.mov
ffmpeg -f lavfi -i 'color=c=red:s=16x16:r=10:d=0.1' -c:v mpeg4 sample.avi
```

`sample.pdf` is a minimal PDF 1.7 containing a catalog, page tree, one blank 16 × 16 page, and a cross-reference table. Raster image fixtures are encoded by Sharp during tests.
