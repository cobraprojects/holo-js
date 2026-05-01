import { defineNotificationsConfig } from '@holo-js/config'

export default defineNotificationsConfig({
  table: 'notifications',
  queue: {
    afterCommit: false,
  },
})
