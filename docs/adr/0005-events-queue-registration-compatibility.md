# Preserve optional Queue integration and synchronous registration

Queue remains the sole owner of job registration, and Events will use its registration interface while preserving synchronous registration and optional Queue installation. Importing Events remains possible without Queue, but requesting registration without Queue reports the same missing-package error as the asynchronous path. This rejects direct private-registry mutation without requiring Queue for applications that do not use queued listeners.

`ensureEventsQueueJobRegistered(): void` and `ensureEventsQueueJobRegisteredAsync(): Promise<void>` remain available and use one registration operation. Native synchronous package loading is the intended direction for the synchronous path, subject to validation on supported runtimes and bundled applications. Registration, reset/re-registration, queued delivery, and missing optional-package behavior must be verified through existing interfaces.

Queue owns normalization, duplicate handling, definition-name associations, and registry representation. Verification retains published-package and bundled-application coverage with and without the optional Queue package; a single local synchronous loading probe is insufficient evidence.
