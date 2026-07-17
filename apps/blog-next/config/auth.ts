import { defineAuthConfig } from '@holo-js/auth'
import { env } from '@holo-js/config'
export default defineAuthConfig({
  defaults: {
    guard: 'web',
    passwords: 'users',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
    admin: {
      driver: 'session',
      provider: 'admins',
    },
    api: {
      driver: 'token',
      provider: 'users',
    },
  },
  providers: {
    users: {
      model: 'User',
      identifiers: ['email'],
    },
    admins: {
      model: 'Admin',
      identifiers: ['email'],
    },
  },
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
      route: env('AUTH_PASSWORD_RESET_ROUTE', '/reset-password'),
    },
  },
  emailVerification: {
    required: true,
    route: env('AUTH_EMAIL_VERIFICATION_ROUTE', '/verify-email'),
  },
  personalAccessTokens: {
    defaultAbilities: [],
  },
  social: {
    google: {
      clientId: env('AUTH_GOOGLE_CLIENT_ID'),
      clientSecret: env('AUTH_GOOGLE_CLIENT_SECRET'),
      redirectUri: env('AUTH_GOOGLE_REDIRECT_URI'),
      scopes: ['openid', 'email', 'profile'],
    },
    github: {
      clientId: env('AUTH_GITHUB_CLIENT_ID'),
      clientSecret: env('AUTH_GITHUB_CLIENT_SECRET'),
      redirectUri: env('AUTH_GITHUB_REDIRECT_URI'),
      scopes: ['read:user', 'user:email'],
    },
  },
  workos: {
    provider: env('AUTH_WORKOS_PROVIDER', 'dashboard'),
    dashboard: {
      clientId: env('WORKOS_CLIENT_ID'),
      apiKey: env('WORKOS_API_KEY'),
      redirectUri: env('WORKOS_REDIRECT_URI'),
    },
  },
  // Add a dedicated guard and provider if WorkOS users should resolve through a different model.
  clerk: {
    provider: env('AUTH_CLERK_PROVIDER', 'app'),
    app: {
      publishableKey: env('CLERK_PUBLISHABLE_KEY'),
      secretKey: env('CLERK_SECRET_KEY'),
      apiUrl: env('CLERK_API_URL'),
      frontendApi: env('CLERK_FRONTEND_API'),
      redirectUri: env('CLERK_REDIRECT_URI'),
      sessionCookie: env('CLERK_SESSION_COOKIE', '__session'),
    },
  },
  // Add a dedicated guard and provider if Clerk users should resolve through a different model.
})
