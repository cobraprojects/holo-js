import { describe, it } from 'vitest'
import notifications, {
  type NotificationDispatchResult,
  type NotificationResultFor,
  type PendingAnonymousNotification,
  type PendingNotificationDispatch,
  defineNotification,
  defineNotificationsConfig,
  notify,
  notifyUsing,
} from '../src'

describe('@holo-js/notifications root export typing', () => {
  it('preserves root-export inference for pending dispatches and config helpers', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const definition = defineNotification({
      type: 'report-ready',
      via(user: { id: string, email: string }) {
        return ['email', 'database'] as const
      },
      build: {
        email(user) {
          return {
            subject: `Report ready for ${user.email}`,
          }
        },
        database(user) {
          return {
            data: {
              userId: user.id,
              ready: true,
            },
          }
        },
      },
    })

    const pending = notify({
      id: 'user-1',
      email: 'ava@example.com',
    }, definition)

    const anonymous = notifyUsing()
      .channel('email', 'ava@example.com')
      .channel('database', { id: 'user-1', type: 'users' })

    const config = defineNotificationsConfig({
      table: 'notifications',
      queue: {
        connection: 'redis',
        queue: 'notifications',
      },
    })

    type PendingAssertion = Expect<Equal<
      typeof pending,
      PendingNotificationDispatch<NotificationDispatchResult>
    >>
    type AnonymousAssertion = Expect<
      typeof anonymous extends PendingAnonymousNotification<{
        readonly email: string | { readonly email: string, readonly name?: string }
        readonly database: { readonly id: string | number, readonly type: string }
      }>
        ? true
        : false
    >
    type ResultAssertion = Expect<Equal<
      NotificationResultFor<'email'>,
      void
    >>

    const fromDefault: typeof notifications.notify = notifications.notify
    const table: string = config.table

    void pending
    void anonymous
    void fromDefault
    void table
    void (0 as unknown as PendingAssertion)
    void (0 as unknown as AnonymousAssertion)
    void (0 as unknown as ResultAssertion)
  })
})
