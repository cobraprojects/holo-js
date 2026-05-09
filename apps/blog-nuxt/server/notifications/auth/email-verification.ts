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
    email(data: EmailVerificationNotification) {
      return {
        subject: 'Verify your email address',
        greeting: data.name ? `Hello ${data.name},` : undefined,
        lines: [
          'Confirm your account to finish signing in.',
          `This verification link expires at ${data.expiresAt.toUTCString()}.`,
        ],
        action: {
          label: 'Verify email address',
          url: data.url,
        },
      }
    },
  },
})
