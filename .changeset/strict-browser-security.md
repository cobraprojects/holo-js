---
'@holo-js/security': patch
'@holo-js/forms': patch
'@holo-js/adapter-next': patch
'@holo-js/adapter-shared': patch
'@holo-js/adapter-sveltekit': patch
'@holo-js/adapter-nuxt': patch
---

Require a submitted CSRF token even with a signed cookie and matching Origin or Referer. Preserve valid Next server-action login, apply configured CORS in framework middleware, allow Nuxt preflights, and serialize validation and throttling failures with their intended HTTP status and retry metadata. Gate releases on generated production app checks for CSRF, CORS, login and concurrent plain-route throttling, session rotation, and logout revocation.
