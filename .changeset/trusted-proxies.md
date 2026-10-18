---
'@holo-js/kernel': patch
'@holo-js/security': patch
'@holo-js/adapter-shared': patch
'@holo-js/adapter-nuxt': patch
'@holo-js/adapter-sveltekit': patch
'@holo-js/cli': patch
'@holo-js/realtime': patch
---

Holo now identifies visitors by the address of their connection, and reads forwarded headers only from proxies you trust.

- Guests are rate limited individually out of the box in Nuxt and SvelteKit apps. Before, every guest shared one `ip:unknown` bucket unless proxy trust was on, so one visitor could lock out everyone.
- New `trustedProxies` option in `config/security.ts`: IP addresses or CIDR ranges of your proxies, or `'*'` to trust the proxy that connects. Holo reads `X-Forwarded-For` (or `Forwarded`) from right to left, skips trusted proxies, and stops at the first untrusted address, so a visitor can no longer pick their own IP by sending `X-Forwarded-For`. Protocol and host come from the nearest trusted proxy. Requests whose `Forwarded` and `X-Forwarded-*` headers disagree are rejected with `400 Bad Request`.
- Next.js doesn't expose the connection address. Without `trustedProxies`, `ip()` and IP-keyed rate limits throw an error that explains how to configure it. New Next.js projects are scaffolded with `trustedProxies: '*'`.
- **Breaking:** `HOLO_SECURITY_TRUST_PROXY` is removed. List your proxies in `trustedProxies` instead.
- **Breaking:** `ip(request, trustedProxy)` is now `ip(request)` and follows `trustedProxies`.
- `@holo-js/realtime` builds into the requested output folder, so workspace test builds no longer overwrite its `dist` folder.
