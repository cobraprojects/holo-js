---
'@holo-js/adapter-next': minor
'@holo-js/adapter-nuxt': minor
'@holo-js/adapter-shared': minor
'@holo-js/adapter-sveltekit': minor
'@holo-js/auth': minor
'@holo-js/cli': minor
'@holo-js/config': minor
'@holo-js/core': minor
'@holo-js/db': minor
'@holo-js/kernel': minor
'@holo-js/queue': minor
'@holo-js/storage': minor
'@holo-js/storage-s3': minor
---

Consolidate shared runtime contracts and plugin loading in `@holo-js/kernel`, centralize framework source transforms in `@holo-js/adapter-shared`, enforce one-way workspace dependencies, compose feature-owned config normalizers without config-to-feature dependencies, move feature config imports to feature packages, and replace database, cache, queue, and storage reverse driver loading with concrete-package registrations.
