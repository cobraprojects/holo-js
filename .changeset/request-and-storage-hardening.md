---
'@holo-js/kernel': patch
'@holo-js/security': patch
'@holo-js/storage': patch
'@holo-js/storage-s3': patch
'@holo-js/core': patch
'@holo-js/auth': patch
'@holo-js/validation': patch
'@holo-js/media': patch
'@holo-js/mail': patch
'@holo-js/db': patch
'@holo-js/adapter-nuxt': patch
---

File types are now detected from file contents everywhere Holo judges a file. Text formats without recognizable contents (CSV, JSON, Markdown, SVG, HTML) use the file extension; a binary extension whose contents do not match, such as text saved as `photo.png`, has no type.

- Public storage shows images, audio, video, fonts, PDFs, and plain text formats inline and sends everything else as a download, so uploads such as XML disguised as images cannot execute on the application origin.
- `image()` validation accepts only complete JPEG, PNG, GIF, WebP, AVIF, and TIFF images identified from their bytes; the browser-reported type is ignored and SVG is rejected. On the server it fully decodes every frame through the optional `sharp` peer of `@holo-js/kernel`, rejecting damaged or truncated files and images over 40,000,000 decoded pixels or 1,000 frames. Without `sharp`, server-side validation reports an error asking to install it.
- Media stores and checks `acceptsMimeTypes()` against the detected type. **Breaking:** the `mimeType` field is removed from `addMedia({ contents, fileName })` and `addMedia({ url })` inputs.
- `Storage.stat()` reports the same type for the same bytes on local, public, and S3 disks. S3 disks read metadata with one ranged GET and ignore stored content types. Custom backends implement `getItemStat(key, { sampleBytes })` by returning the file size and leading bytes, and `stat()` resolves paths like every other disk operation.
- `inferMimeTypeFromName()` in mail recognizes more extensions (`avif`, `css`, `mp3`, `woff`, `woff2`); existing answers are unchanged.
- `file-type` is installed only with packages that inspect file contents (storage, validation, media); kernel declares it as an optional peer.
- Nuxt pre-bundles `file-type` alongside validation's client dependencies, so the first `image()` check in development doesn't trigger a page reload.
- `mediaRuntimeInternals.inspectImage()` is removed from `@holo-js/media`.

`HOLO_SECURITY_TRUST_PROXY` now trusts exactly one proxy header family: `true`, `1`, `yes`, `on`, or `x-forwarded` trust `X-Forwarded-*`, and `forwarded` trusts the RFC 7239 `Forwarded` header. The two families are never mixed, and rate-limit client addresses follow the same family. **Behavior change:** deployments whose proxy sends only `Forwarded` must set `HOLO_SECURITY_TRUST_PROXY=forwarded`.

`Forwarded` values are parsed with quoted strings intact, and rate-limit keys use the bare client address from `for=`, ignoring ports and obfuscated identifiers.

Malformed request URLs and trusted proxy headers are rejected with `400 Bad Request` by the security middleware instead of failing the request with a server error, and `Forwarded` segments without a value are ignored.

When the broadcast worker cannot be reached, `broadcast()` now throws `[@holo-js/core] Broadcast publish request could not reach the broadcast worker at <origin>.` with the network error as its cause, instead of a raw `fetch failed` error.
