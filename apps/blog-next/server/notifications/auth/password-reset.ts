import { defineNotification } from '@holo-js/notifications'

interface PasswordResetNotification {
  readonly email: string
  readonly url: string
  readonly expiresAt: Date
}

export default defineNotification({
  type: 'auth.password-reset',
  via() {
    return ['email']
  },
  build: {
    email(data: PasswordResetNotification) {
      return {
        subject: 'Reset your password',
        lines: [
          'Click the link below to choose a new password.',
          `This reset link expires at ${data.expiresAt.toUTCString()}.`,
        ],
        action: {
          label: 'Reset password',
          url: data.url,
        },
      }
    },
  },
})
