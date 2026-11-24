import { defineNotification } from '@holo-js/notifications'

interface EmailVerificationNotification {
  readonly email: string
  readonly name?: string
  readonly url: string
  readonly expiresInMinutes: number
}

export default defineNotification({
  type: 'auth.email-verification',
  via() {
    return ['email']
  },
  build: {
    email(data: EmailVerificationNotification) {
      return {
        subject: 'Verify Email Address',
        lines: [
          'Please click the button below to verify your email address.',
        ],
        action: {
          label: 'Verify Email Address',
          url: data.url,
        },
        outroLines: [
          'If you did not create an account, no further action is required.',
        ],
      }
    },
  },
})
