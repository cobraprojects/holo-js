import { describe, expect, it } from 'vitest'
import {
  defineEvent,
  defineListener,
  eventInternals,
  isEventDefinition,
  isListenerDefinition,
  normalizeEventDefinition,
  normalizeListenerDefinition,
} from '../src'

describe('@holo-js/events contracts', () => {
  it('normalizes and freezes valid event definitions', () => {
    const event = defineEvent<{ userId: string }>({
      name: ' user.registered ',
    })
    const unnamed = defineEvent<{
      auditId: string
    }>({})

    expect(event).toEqual({
      name: 'user.registered',
    })
    expect(Object.isFrozen(event)).toBe(true)
    expect(unnamed).toEqual({})
    expect(Object.isFrozen(unnamed)).toBe(true)
  })

  it('supports explicit and path-derived event naming helpers', () => {
    const event = defineEvent({ name: 'audit.entry' })
    const listener = defineListener({
      listensTo: ['audit.entry'],
      async handle() {},
    })

    expect(normalizeEventDefinition({ name: ' report.generated ' }).name).toBe('report.generated')
    expect(eventInternals.deriveEventNameFromSourcePath('server/events/user/registered.ts')).toBe('user.registered')
    expect(eventInternals.deriveEventNameFromSourcePath('C:\\app\\server\\events\\audit\\entry.ts')).toBe('audit.entry')
    expect(eventInternals.deriveEventNameFromSourcePath('audit/entry.ts')).toBe('audit.entry')
    expect(eventInternals.hasEventDefinitionMarker(event)).toBe(true)
    expect(eventInternals.hasEventDefinitionMarker({ name: 'audit.entry' })).toBe(false)
    expect(eventInternals.hasListenerDefinitionMarker(listener)).toBe(true)
    expect(eventInternals.hasListenerDefinitionMarker({ listensTo: ['audit.entry'], async handle() {} })).toBe(false)
  })

  it('rejects invalid event definitions and derived naming inputs', () => {
    expect(() => defineEvent({
      name: '   ',
    })).toThrow('Event name must be a non-empty string when provided.')

    expect(() => normalizeEventDefinition(null as never)).toThrow('Events must be plain objects.')

    expect(() => eventInternals.deriveEventNameFromSourcePath('server/events/.ts')).toThrow(
      'Derived event names require a non-empty source path.',
    )
  })

  it('normalizes and freezes listener definitions for single and multiple events', () => {
    const userRegistered = defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    })
    const userDeleted = defineEvent<{ userId: string }, 'user.deleted'>({
      name: 'user.deleted',
    })

    const single = defineListener({
      listensTo: [userRegistered] as const,
      async handle() {
        return 'ok'
      },
    })

    const multiple = defineListener({
      name: ' audit.user ',
      listensTo: [userRegistered, userDeleted, ' user.suspended '],
      queue: true,
      connection: ' redis ',
      queueName: ' listeners ',
      delay: new Date('2026-01-01T00:00:00.000Z'),
      afterCommit: true,
      async handle() {
        return 'queued'
      },
    })

    expect(single.listensTo).toEqual([userRegistered])
    expect(Object.isFrozen(single)).toBe(true)
    expect(Object.isFrozen(single.listensTo)).toBe(true)

    expect(multiple).toMatchObject({
      name: 'audit.user',
      queue: true,
      connection: 'redis',
      queueName: 'listeners',
      delay: new Date('2026-01-01T00:00:00.000Z'),
      afterCommit: true,
    })
    expect(multiple.listensTo).toEqual([userRegistered, userDeleted, 'user.suspended'])
    expect(Object.isFrozen(multiple)).toBe(true)
    expect(Object.isFrozen(multiple.listensTo)).toBe(true)
  })

  it('rejects invalid listener definitions and metadata combinations', () => {
    const validEvent = defineEvent<{ id: string }, 'entity.created'>({
      name: 'entity.created',
    })

    expect(() => defineListener({
      listensTo: [],
      async handle() {},
    })).toThrow('Listeners must listen to at least one event.')

    expect(() => defineListener({
      listensTo: ['  '],
      async handle() {},
    })).toThrow('Listener event reference at index 0 must be a non-empty string.')

    expect(() => defineListener({
      listensTo: [validEvent] as const,
      connection: 'redis',
      async handle() {},
    })).toThrow('Listener queue metadata requires queue: true.')

    expect(() => defineListener({
      listensTo: [validEvent] as const,
      queue: true,
      delay: -1,
      async handle() {},
    })).toThrow('Listener delay must be a finite number greater than or equal to 0.')

    expect(() => defineListener({
      listensTo: [validEvent] as const,
      queue: 'yes' as never,
      async handle() {},
    })).toThrow('Listener queue must be a boolean when provided.')

    expect(() => defineListener({
      listensTo: [validEvent] as const,
      queue: true,
      delay: new Date(Number.NaN),
      async handle() {},
    })).toThrow('Listener delay dates must be valid Date instances.')

    expect(() => eventInternals.normalizeListensTo([42 as never])).toThrow(
      'Listener event reference at index 0 must be an event definition or string.',
    )

    expect(() => normalizeListenerDefinition({
      listensTo: [validEvent] as const,
      handle: 'not-a-function',
    } as never)).toThrow('Listeners must define "listensTo" and a "handle" function.')
  })

  it('exposes contract guards and normalization helpers for internal consumers', () => {
    const event = {
      name: 'audit.logged',
    }
    const listener = {
      listensTo: ['audit.logged'],
      async handle() {},
    }

    expect(isEventDefinition(event)).toBe(true)
    expect(isEventDefinition(undefined)).toBe(false)
    expect(isListenerDefinition(listener)).toBe(true)
    expect(isListenerDefinition({ listensTo: [] })).toBe(false)
    expect(eventInternals.normalizeOptionalString(undefined, 'Event name')).toBeUndefined()
    expect(eventInternals.normalizeOptionalBoolean(undefined, 'Listener queue')).toBeUndefined()
    expect(eventInternals.normalizeOptionalDelay(undefined)).toBeUndefined()
    expect(eventInternals.toPosixPath('server\\events\\user\\registered.ts')).toBe('server/events/user/registered.ts')
  })
})
