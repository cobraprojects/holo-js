# Protect migration file creation as a project workflow

Migration file creation will validate the whole batch before writing, serialize discovery and creation per project, and create files exclusively so concurrent commands cannot overwrite an existing file. If writing fails, cleanup removes only files created by that attempt. Table definitions stay with their owning modules; shared creation ownership centralizes conflict handling and preparation without becoming a general artifact framework.

If all files were written successfully but framework preparation fails, the completed migration files remain and the command reports both their creation and the preparation failure. Subsequent conflict checks recognize those files even when generated discovery is stale. Existing command names and configuration remain unchanged.
