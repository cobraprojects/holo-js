import { describe, it } from 'vitest'
import {
  Event,
  dispatchEvent,
  type EventDefinition,
  type EventEnvelope,
  type EventPendingDispatch,
  type EventPayloadFor,
  type ListenerDefinition,
  defineEvent,
  defineListener,
} from '../src'

declare module '../src' {
  interface HoloEventRegistry {
    'user.registered': EventDefinition<{ userId: string; email: string }, 'user.registered'>
    'user.deleted': EventDefinition<{ userId: string; reason?: string }, 'user.deleted'>
  }
}

describe('@holo-js/events typing', () => {
  it('preserves inference for event definitions, listener unions, and dispatch entrypoints', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const userRegistered = defineEvent<{ userId: string; email: string }, 'user.registered'>({
      name: 'user.registered',
    })
    const userDeleted = defineEvent<{ userId: string; reason?: string }, 'user.deleted'>({
      name: 'user.deleted',
    })

    const multiListener = defineListener({
      listensTo: [userRegistered, userDeleted] as const,
      handle(event) {
        return event.name
      },
    } satisfies ListenerDefinition<readonly [typeof userRegistered, typeof userDeleted], string>)

    type MultiEvent = Parameters<typeof multiListener.handle>[0]
    type MultiEventName = MultiEvent['name']
    type MultiEventPayload = MultiEvent['payload']
    type PayloadFromRegistry = EventPayloadFor<'user.registered'>
    type ListenerContract = ListenerDefinition<readonly [typeof userRegistered, typeof userDeleted], string>

    const listenerContract: ListenerContract = multiListener
    const explicitPending = dispatchEvent(userRegistered, {
      userId: 'usr-1',
      email: 'ava@example.com',
    })
    const namedPending = dispatchEvent('user.registered', {
      userId: 'usr-1',
      email: 'ava@example.com',
    })
    const facadePending = Event.dispatch('user.registered', {
      userId: 'usr-1',
      email: 'ava@example.com',
    })
    const dynamicPending: EventPendingDispatch<{ anything: boolean }> = dispatchEvent(`audit.${'logged'}`, {
      anything: true,
    })

    type ExplicitEnvelope = EventEnvelope<'user.registered', { userId: string; email: string }>
    type MultiNameAssertion = Expect<Equal<
      MultiEventName,
      'user.registered' | 'user.deleted'
    >>
    type MultiPayloadAssertion = Expect<Equal<
      MultiEventPayload,
      { userId: string; email: string } | { userId: string; reason?: string }
    >>
    type RegistryPayloadAssertion = Expect<Equal<
      PayloadFromRegistry,
      { userId: string; email: string }
    >>

    const explicitEnvelope: ExplicitEnvelope = {
      name: 'user.registered',
      payload: {
        userId: 'usr-1',
        email: 'ava@example.com',
      },
      occurredAt: Date.now(),
    }

    void listenerContract
    void explicitPending
    void namedPending
    void facadePending
    void dynamicPending
    void explicitEnvelope
    void (0 as unknown as MultiNameAssertion)
    void (0 as unknown as MultiPayloadAssertion)
    void (0 as unknown as RegistryPayloadAssertion)
  })
})
