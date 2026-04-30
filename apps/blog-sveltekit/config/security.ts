import { defineSecurityConfig, limit } from '@holo-js/security'

export default defineSecurityConfig({
  csrf: {
    enabled: true,
    field: '_token',
    header: 'X-CSRF-TOKEN',
    cookie: 'XSRF-TOKEN',
    except: [],
  },
  rateLimit: {
    driver: 'file',
    file: {
      path: './storage/framework/rate-limits',
    },
    redis: {
      connection: 'default',
      prefix: 'holo:rate-limit:',
    },
    limiters: {
      login: limit.perMinute(5).define(),
      register: limit.perHour(10).define(),
    },
  },
})
