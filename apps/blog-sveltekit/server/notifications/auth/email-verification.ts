import { defineNotification } from '@holo-js/notifications'

interface EmailVerificationNotification {
  readonly email: string
  readonly name?: string
  readonly url: string
  readonly expiresAt: Date
}

export default defineNotification({
  type: 'auth.email-verification',
  via() {
    return ['email']
  },
  build: {
    email(input: EmailVerificationNotification) {
      return {
        subject: 'Verify your email address NOW',
        greeting: input.name ? `Hello ${input.name},` : undefined,
        lines: [
          'Confirm your account to finish signing in.',
          `This verification link expires at ${input.expiresAt.toLocaleString()}.`,
        ],
        action: {
          label: 'Verify email address',
          url: input.url,
        },
      }
    },
  },
})
