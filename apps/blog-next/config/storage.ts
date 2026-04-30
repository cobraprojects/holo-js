import { defineStorageConfig, env } from '@holo-js/config'

export default defineStorageConfig({
  defaultDisk: env('STORAGE_DEFAULT_DISK', 'local'),
  routePrefix: env('STORAGE_ROUTE_PREFIX', '/storage'),
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
    },
    public: {
      driver: 'public',
      root: './storage/app/public',
      visibility: 'public',
    },
  },
})
