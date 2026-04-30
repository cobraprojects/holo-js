import { defineAuthConfig, env } from '@holo-js/config'

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
    // admin: {
    //   driver: 'session',
    //   provider: 'admins',
    // },
  },
  providers: {
    users: {
      model: 'User',
      identifiers: ['email'],
    },
    // admins: {
    //   model: 'Admin',
    //   identifiers: ['email'],
    // },
  },
  passwords: {
    users: {
      provider: 'users',
      table: 'password_reset_tokens',
      expire: 60,
      throttle: 60,
    },
  },
  emailVerification: {
    required: false,
  },
  personalAccessTokens: {
    defaultAbilities: [],
  },
  socialEncryptionKey: env('AUTH_SOCIAL_ENCRYPTION_KEY'),
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
    dashboard: {
      clientId: env('WORKOS_CLIENT_ID'),
      apiKey: env('WORKOS_API_KEY'),
      cookiePassword: env('WORKOS_COOKIE_PASSWORD'),
      redirectUri: env('WORKOS_REDIRECT_URI'),
      sessionCookie: env('WORKOS_SESSION_COOKIE', "wos-session"),
    },
  },
  // Add a dedicated guard and provider if WorkOS users should resolve through a different model.
  clerk: {
    app: {
      publishableKey: env('CLERK_PUBLISHABLE_KEY'),
      secretKey: env('CLERK_SECRET_KEY'),
      jwtKey: env('CLERK_JWT_KEY'),
      apiUrl: env('CLERK_API_URL'),
      frontendApi: env('CLERK_FRONTEND_API'),
      sessionCookie: env('CLERK_SESSION_COOKIE', "__session"),
    },
  },
  // Add a dedicated guard and provider if Clerk users should resolve through a different model.
})
