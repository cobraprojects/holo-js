# Protect migration file creation as a project workflow

Migration file creation will validate the whole batch before writing, serialize discovery and creation per project, and create files exclusively so concurrent commands cannot overwrite an existing file. If writing fails, cleanup removes only files created by that attempt. Table definitions stay with their owning modules; shared creation ownership centralizes conflict handling and preparation without becoming a general artifact framework.

If all files were written successfully but framework preparation fails, the completed migration files remain and the command reports both their creation and the preparation failure. Subsequent conflict checks recognize those files even when generated discovery is stale. Existing command names and configuration remain unchanged.

Verification executes ordinary, Queue, Cache, and Media commands against real temporary projects. It covers duplicate slugs, table conflicts, normalized-name collisions, stale discovery, whole-batch refusal, concurrent conflicting creators, exclusive writes, owned-file cleanup, and retained files after preparation failure. This workflow does not promise crash-atomic multi-file publication.
