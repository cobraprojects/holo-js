import { defineNotificationsConfig } from '@holo-js/notifications'
export default defineNotificationsConfig({
  table: 'notifications',
  queue: {
    afterCommit: false,
  },
})
