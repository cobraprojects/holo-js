import { describe, it } from 'vitest'
import notifications, {
  type NotificationDispatchResult,
  type NotificationBuildFactories,
  type NotificationDefinition,
  type NotificationJsonValue,
  type NotificationPage,
  type NotificationPagination,
  type NotificationQuery,
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
        return ['email', 'database']
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
    }, definition).deduplicate('outbox-1')

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
    type DispatchAssertion = Expect<Equal<
      ReturnType<typeof pending.dispatch>,
      Promise<NotificationDispatchResult>
    >>
    type AnonymousAssertion = Expect<
      Equal<
        typeof anonymous,
        PendingAnonymousNotification<{
        readonly email: string | { readonly email: string, readonly name?: string }
        readonly database: { readonly id: string | number, readonly type: string }
      }>
      >
    >
    type ResultAssertion = Expect<Equal<
      NotificationResultFor<'email'>,
      void
    >>
    type QueryAssertion = Expect<Equal<
      NotificationQuery,
      {
        readonly recipient: { readonly id: string | number, readonly type: string }
        readonly type?: string
        readonly dataMatches?: readonly {
          readonly path: readonly string[]
          readonly value: string | number | boolean | null
        }[]
      }
    >>
    type PaginationAssertion = Expect<Equal<
      NotificationPagination,
      { readonly limit: number, readonly offset: number }
    >>
    type PageRecordsAssertion = Expect<Equal<
      NotificationPage['records'][number]['data'],
      NotificationJsonValue
    >>

    const fromDefault: typeof notifications.notify = notifications.notify
    const table: 'notifications' = config.table

    void pending
    void anonymous
    void fromDefault
    void table
    void (0 as unknown as PendingAssertion)
    void (0 as unknown as DispatchAssertion)
    void (0 as unknown as AnonymousAssertion)
    void (0 as unknown as ResultAssertion)
    void (0 as unknown as QueryAssertion)
    void (0 as unknown as PaginationAssertion)
    void (0 as unknown as PageRecordsAssertion)
  })

  it('composes inferred definitions through generic framework APIs', () => {
    function dispatch<TNotifiable, TBuild extends NotificationBuildFactories<TNotifiable>>(
      notifiable: TNotifiable,
      definition: NotificationDefinition<TNotifiable, TBuild>,
    ) {
      return notify(notifiable, definition).deduplicate('operation-1').dispatch()
    }

    const definition = defineNotification({
      via(user: { readonly id: string }) {
        return ['database']
      },
      build: {
        database(user) {
          return { data: { userId: user.id } }
        },
      },
    })

    const result: Promise<NotificationDispatchResult> = dispatch({ id: 'user-1' }, definition)

    void result
  })
})
