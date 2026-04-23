import { describe, it } from 'vitest'
import {
  type AnonymousNotificationTarget,
  type HoloNotificationChannelRegistry,
  type InferNotificationChannels,
  type InferNotificationNotifiable,
  type NotificationChannel,
  type NotificationChannelName,
  type NotificationPayloadFor,
  type NotificationRouteFor,
  defineNotification,
  notify,
  notifyUsing,
} from '../src'

declare module '../src/contracts' {
  interface HoloNotificationChannelRegistry {
    readonly slack: NotificationChannel<
      { readonly webhook: string },
      { readonly text: string },
      void
    >
  }
}

describe('@holo-js/notifications typing', () => {
  it('preserves notification, route, and custom channel inference', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    type ChannelNames = NotificationChannelName
    type SlackRoute = NotificationRouteFor<'slack'>
    type SlackPayload = NotificationPayloadFor<'slack'>
    type RegistryAssertion = Expect<Equal<
      Extract<ChannelNames, 'slack'>,
      'slack'
    >>
    type RouteAssertion = Expect<Equal<
      SlackRoute,
      { readonly webhook: string }
    >>
    type PayloadAssertion = Expect<Equal<
      SlackPayload,
      { readonly text: string }
    >>

    const userRegistered = defineNotification({
      type: 'user.registered',
      via(user: { id: string, email: string }) {
        return ['email', 'slack'] as const
      },
      build: {
        email(user) {
          return {
            subject: `Welcome ${user.email}`,
          }
        },
        slack(user) {
          return {
            text: `Registered ${user.id}`,
          }
        },
      },
    })

    type RegisteredNotifiable = InferNotificationNotifiable<typeof userRegistered>
    type NotifiableAssertion = Expect<Equal<
      RegisteredNotifiable,
      { id: string, email: string }
    >>

    const pending = notify({
      id: 'user-1',
      email: 'ava@example.com',
    }, userRegistered)

    const routed = notifyUsing()
      .channel('email', { email: 'ava@example.com', name: 'Ava' })
      .channel('slack', { webhook: 'https://hooks.slack.test' })

    type RoutedTarget = typeof routed.target
    type RoutedAssertion = Expect<
      RoutedTarget extends AnonymousNotificationTarget<{
        readonly email: NotificationRouteFor<'email'>
        readonly slack: SlackRoute
      }>
        ? true
        : false
    >

    const channelName: ChannelNames = 'slack'
    const route: SlackRoute = { webhook: 'https://hooks.slack.test' }
    const payload: SlackPayload = { text: 'hi' }

    // @ts-expect-error Wrong notifiable shape must fail.
    notify({ id: 'user-1' }, userRegistered)

    // @ts-expect-error Wrong route shape for the custom channel must fail.
    notifyUsing().channel('slack', 'broken')

    void pending
    void routed
    void channelName
    void route
    void payload
    void (0 as unknown as HoloNotificationChannelRegistry)
    void (0 as unknown as RegistryAssertion)
    void (0 as unknown as RouteAssertion)
    void (0 as unknown as PayloadAssertion)
    void (0 as unknown as NotifiableAssertion)
    void (0 as unknown as RoutedAssertion)
  })
})
