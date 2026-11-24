import { defineNotification } from '@holo-js/notifications'

interface PasswordResetNotification {
  readonly email: string
  readonly url: string
  readonly expiresInMinutes: number
}

export default defineNotification({
  type: 'auth.password-reset',
  via() {
    return ['email']
  },
  build: {
    email(data: PasswordResetNotification) {
      return {
        subject: 'Reset Password Notification',
        lines: [
          'You are receiving this email because we received a password reset request for your account.',
        ],
        action: {
          label: 'Reset Password',
          url: data.url,
        },
        outroLines: [
          `This password reset link will expire in ${data.expiresInMinutes} minutes.`,
          'If you did not request a password reset, no further action is required.',
        ],
      }
    },
  },
})
