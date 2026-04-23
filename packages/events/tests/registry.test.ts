import { afterEach, describe, expect, it } from 'vitest'
import {
  defineEvent,
  defineListener,
  eventRegistryInternals,
  getRegisteredEvent,
  getRegisteredListener,
  listRegisteredEvents,
  listRegisteredListeners,
  listRegisteredListenersForEvent,
  registerEvent,
  registerEvents,
  registerListener,
  registerListeners,
  resetEventRegistry,
  resetEventsRegistry,
  resetListenerRegistry,
  unregisterEvent,
  unregisterListener,
} from '../src'

afterEach(() => {
  resetEventsRegistry()
})

describe('@holo-js/events registry', () => {
  it('returns empty lookups before any registrations exist', () => {
    expect(getRegisteredEvent('user.registered')).toBeUndefined()
    expect(getRegisteredListener('send-welcome-email')).toBeUndefined()
    expect(listRegisteredEvents()).toEqual([])
    expect(listRegisteredListeners()).toEqual([])
    expect(listRegisteredListenersForEvent('user.registered')).toEqual([])
  })

  it('registers events from explicit names, definition names, and source-path-derived names', () => {
    const packageEvent = registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    const overriddenEvent = registerEvent(defineEvent<{ orderId: string }, 'ignored.name'>({
      name: 'ignored.name',
    }), {
      name: 'orders.shipped',
    })
    const discoveredEvent = registerEvent(defineEvent<{ auditId: string }>({}), {
      sourcePath: 'server/events/audit/logged.ts',
    })
    const batch = registerEvents([
      {
        definition: defineEvent<{ orderId: string }>({}),
        options: {
          sourcePath: 'server/events/orders/cancelled.ts',
        },
      },
    ])

    expect(packageEvent.name).toBe('user.registered')
    expect(overriddenEvent.name).toBe('orders.shipped')
    expect(discoveredEvent.name).toBe('audit.logged')
    expect(batch).toHaveLength(1)
    expect(getRegisteredEvent('audit.logged')?.sourcePath).toBe('server/events/audit/logged.ts')
    expect(listRegisteredEvents().map(entry => entry.name)).toEqual([
      'audit.logged',
      'orders.cancelled',
      'orders.shipped',
      'user.registered',
    ])
  })

  it('rejects duplicate, unnamed, and malformed event registrations', () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    expect(() => registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))).toThrow('Event "user.registered" is already registered.')

    expect(() => registerEvent(defineEvent({}))).toThrow(
      'Registered events require an explicit name or a sourcePath-derived name.',
    )

    expect(() => registerEvent(null as never)).toThrow('Events must be plain objects.')
  })

  it('applies normalized names first and treats explicit and path-derived collisions as the same event identity', () => {
    registerEvent(defineEvent<{ userId: string }>({
      name: ' user.registered ',
    }))

    expect(() => registerEvent(defineEvent<{ userId: string }>({}), {
      sourcePath: 'server/events/user/registered.ts',
    })).toThrow('Event "user.registered" is already registered.')

    const replaced = registerEvent(defineEvent<{ userId: string }>({}), {
      sourcePath: 'server/events/user/registered.ts',
      replaceExisting: true,
    })

    expect(replaced.name).toBe('user.registered')
    expect(replaced.sourcePath).toBe('server/events/user/registered.ts')
  })

  it('replaces events only when explicitly requested', () => {
    registerEvent(defineEvent<{ first: true }, 'reports.ready'>({
      name: 'reports.ready',
    }))

    const replaced = registerEvent(defineEvent<{ second: true }, 'reports.ready'>({
      name: 'reports.ready',
    }), {
      replaceExisting: true,
      sourcePath: 'server/events/reports/ready.ts',
    })

    expect(replaced.sourcePath).toBe('server/events/reports/ready.ts')
    expect(getRegisteredEvent('reports.ready')?.sourcePath).toBe('server/events/reports/ready.ts')
  })

  it('registers listeners, expands multi-event listeners, and preserves registration order per event', () => {
    const userRegistered = registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    const userDeleted = registerEvent(defineEvent<{ userId: string }, 'user.deleted'>({
      name: 'user.deleted',
    }))

    const first = registerListener(defineListener({
      name: 'send.welcome',
      listensTo: [userRegistered.definition],
      async handle() {},
    }))
    const second = registerListener(defineListener({
      name: 'audit.lifecycle',
      listensTo: [userRegistered.definition, userDeleted.definition, 'user.registered'] as const,
      queue: true,
      queueName: 'listeners',
      afterCommit: true,
      async handle() {},
    }))
    const third = registerListener(defineListener({
      listensTo: [userDeleted.definition],
      async handle() {},
    }), {
      sourcePath: 'server/listeners/user/prune-profile.ts',
    })
    const batch = registerListeners([
      {
        definition: defineListener({
          name: 'notify.ops',
          listensTo: [userRegistered.definition],
          async handle() {},
        }),
      },
    ])
    const idOverride = registerListener(defineListener({
      name: 'ignored.listener.name',
      listensTo: [userDeleted.definition],
      async handle() {},
    }), {
      id: 'listener.id.override',
    })

    expect(first.id).toBe('send.welcome')
    expect(second.eventNames).toEqual(['user.registered', 'user.deleted'])
    expect(third.id).toBe('user.prune-profile')
    expect(idOverride.id).toBe('listener.id.override')
    expect(batch).toHaveLength(1)
    expect(getRegisteredListener('user.prune-profile')?.sourcePath).toBe('server/listeners/user/prune-profile.ts')
    expect(listRegisteredListeners().map(entry => entry.id)).toEqual([
      'audit.lifecycle',
      'listener.id.override',
      'notify.ops',
      'send.welcome',
      'user.prune-profile',
    ])
    expect(listRegisteredListenersForEvent('user.registered').map(entry => entry.id)).toEqual([
      'send.welcome',
      'audit.lifecycle',
      'notify.ops',
    ])
    expect(listRegisteredListenersForEvent('user.deleted').map(entry => entry.id)).toEqual([
      'audit.lifecycle',
      'user.prune-profile',
      'listener.id.override',
    ])
  })

  it('rejects duplicate, unresolved, unnamed, and malformed listener registrations', () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      async handle() {},
    }))

    expect(() => registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      async handle() {},
    }))).toThrow('Listener "send.welcome" is already registered.')

    expect(() => registerListener(defineListener({
      listensTo: ['missing.event'],
      async handle() {},
    }), {
      sourcePath: 'server/listeners/missing.ts',
    })).toThrow('Listener target event "missing.event" is not registered.')

    expect(() => registerListener(defineListener({
      listensTo: [defineEvent<object>({})],
      async handle() {},
    }), {
      sourcePath: 'server/listeners/invalid.ts',
    })).toThrow('Listener event references must resolve to explicit event names before registration.')

    expect(() => registerListener(defineListener({
      listensTo: ['user.registered'],
      async handle() {},
    }))).toThrow(
      'Registered listeners require an explicit id, listener name, or a sourcePath-derived id.',
    )

    expect(() => registerListener({
      listensTo: ['user.registered'],
      handle: 'not-a-function',
    } as never)).toThrow('Listeners must define "listensTo" and a "handle" function.')
  })

  it('replaces listeners only when explicitly requested and refreshes event indexes', () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    registerEvent(defineEvent<{ userId: string }, 'user.deleted'>({
      name: 'user.deleted',
    }))

    registerListener(defineListener({
      name: 'audit.lifecycle',
      listensTo: ['user.registered'],
      async handle() {},
    }))

    const replaced = registerListener(defineListener({
      name: 'audit.lifecycle',
      listensTo: ['user.deleted'],
      async handle() {},
    }), {
      replaceExisting: true,
      sourcePath: 'server/listeners/audit/lifecycle.ts',
    })

    expect(replaced.sourcePath).toBe('server/listeners/audit/lifecycle.ts')
    expect(listRegisteredListenersForEvent('user.registered')).toEqual([])
    expect(listRegisteredListenersForEvent('user.deleted').map(entry => entry.id)).toEqual(['audit.lifecycle'])
  })

  it('supports unregister and reset helpers without leaking process state', () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))
    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      async handle() {},
    }))

    expect(() => unregisterEvent('user.registered')).toThrow(
      'Event "user.registered" cannot be unregistered while listeners are registered for it.',
    )
    expect(unregisterListener('missing.listener')).toBe(false)
    expect(unregisterListener('send.welcome')).toBe(true)
    expect(unregisterEvent('missing.event')).toBe(false)
    expect(unregisterEvent('user.registered')).toBe(true)

    registerEvent(defineEvent<{ auditId: string }, 'audit.logged'>({
      name: 'audit.logged',
    }))
    registerListener(defineListener({
      name: 'audit.first',
      listensTo: ['audit.logged'],
      async handle() {},
    }))
    registerListener(defineListener({
      name: 'audit.second',
      listensTo: ['audit.logged'],
      async handle() {},
    }))

    expect(unregisterListener('audit.first')).toBe(true)
    expect(listRegisteredListenersForEvent('audit.logged').map(entry => entry.id)).toEqual(['audit.second'])

    registerEvent(defineEvent<{ auditId: string }, 'audit.reset'>({
      name: 'audit.reset',
    }))
    registerListener(defineListener({
      name: 'audit.writer',
      listensTo: ['audit.reset'],
      async handle() {},
    }))

    resetEventsRegistry()

    expect(listRegisteredEvents()).toEqual([])
    expect(listRegisteredListeners()).toEqual([])
    expect(listRegisteredListenersForEvent('audit.reset')).toEqual([])
  })

  it('clears listener registrations when resetting only the event registry', () => {
    const hitIds: string[] = []

    registerEvent(defineEvent<{ auditId: string }, 'audit.logged'>({
      name: 'audit.logged',
    }))
    registerListener(defineListener({
      name: 'audit.writer',
      listensTo: ['audit.logged'],
      async handle() {
        hitIds.push('stale-listener')
      },
    }))

    resetEventRegistry()

    expect(listRegisteredEvents()).toEqual([])
    expect(listRegisteredListeners()).toEqual([])
    expect(listRegisteredListenersForEvent('audit.logged')).toEqual([])

    registerEvent(defineEvent<{ auditId: string }, 'audit.logged'>({
      name: 'audit.logged',
    }))

    expect(listRegisteredListeners()).toEqual([])
    expect(listRegisteredListenersForEvent('audit.logged')).toEqual([])
    expect(hitIds).toEqual([])
  })

  it('exposes dedicated listener and combined reset helpers', () => {
    registerEvent(defineEvent<{ auditId: string }, 'audit.logged'>({
      name: 'audit.logged',
    }))
    registerListener(defineListener({
      name: 'audit.writer',
      listensTo: ['audit.logged'],
      async handle() {},
    }))

    resetListenerRegistry()

    expect(listRegisteredEvents().map(entry => entry.name)).toEqual(['audit.logged'])
    expect(listRegisteredListeners()).toEqual([])
    expect(listRegisteredListenersForEvent('audit.logged')).toEqual([])

    registerListener(defineListener({
      name: 'audit.writer',
      listensTo: ['audit.logged'],
      async handle() {},
    }))

    resetEventsRegistry()

    expect(listRegisteredEvents()).toEqual([])
    expect(listRegisteredListeners()).toEqual([])
    expect(listRegisteredListenersForEvent('audit.logged')).toEqual([])
  })

  it('exposes internal naming helpers for event and listener registration', () => {
    expect(eventRegistryInternals.deriveListenerIdFromSourcePath('server/listeners/user/send-welcome-email.ts')).toBe(
      'user.send-welcome-email',
    )
    expect(eventRegistryInternals.deriveListenerIdFromSourcePath('plain-listener.ts')).toBe('plain-listener')
    expect(eventRegistryInternals.resolveRegisteredEventName(defineEvent({ name: 'audit.logged' }))).toBe('audit.logged')
    expect(eventRegistryInternals.resolveRegisteredListenerId(defineListener({
      name: 'audit.writer',
      listensTo: ['audit.logged'],
      async handle() {},
    }))).toBe('audit.writer')
    expect(() => eventRegistryInternals.deriveListenerIdFromSourcePath('server/listeners/.ts')).toThrow(
      'Derived listener identifiers require a non-empty source path.',
    )
  })

  it('handles defensive listener-index cleanup branches', () => {
    registerEvent(defineEvent<{ auditId: string }, 'audit.logged'>({
      name: 'audit.logged',
    }))
    registerListener(defineListener({
      name: 'audit.writer',
      listensTo: ['audit.logged'],
      async handle() {},
    }))

    const state = eventRegistryInternals.getEventRegistryState()
    state.listenersByEvent.delete('audit.logged')

    expect(unregisterListener('audit.writer')).toBe(true)
    expect(listRegisteredListenersForEvent('audit.logged')).toEqual([])
  })
})
