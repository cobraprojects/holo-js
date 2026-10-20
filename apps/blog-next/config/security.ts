import { defineSecurityConfig, limit } from '@holo-js/security'

export default defineSecurityConfig({
  trustedProxies: '*',
  csrf: {
    enabled: true,
    field: '_token',
    header: 'X-CSRF-TOKEN',
    cookie: 'XSRF-TOKEN',
    except: ['/api/v1/*'],
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
      emailVerificationResend: limit.perMinute(6).define(),
    },
  },
})
