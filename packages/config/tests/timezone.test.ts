import { afterEach, describe, expect, it } from 'vitest'
import { configureConfigRuntime, loadConfigDirectory, normalizeAppConfig, resetConfigRuntime } from '../src'

afterEach(() => resetConfigRuntime())

describe('application timezone', () => {
  it('defaults to UTC when no timezone is configured', () => {
    expect(normalizeAppConfig().timezone).toBe('UTC')
  })

  it.each(['UTC', 'Africa/Cairo', 'Asia/Riyadh', 'America/New_York'])(
    'retains the configured timezone %s',
    timezone => {
      expect(normalizeAppConfig({ timezone }).timezone).toBe(timezone)
    },
  )

  it.each(['', 'Mars/Olympus', 'Africa/Invalid'])(
    'rejects the invalid timezone %j',
    timezone => {
      expect(() => normalizeAppConfig({ timezone })).toThrow(`Invalid application timezone: ${timezone}`)
    },
  )

  it.each(['+05:30', '-04:00'])(
    'rejects numeric timezone offset %s instead of using the host timezone',
    timezone => {
      expect(() => normalizeAppConfig({ timezone })).toThrow(`Invalid application timezone: ${timezone}`)
    },
  )

  it('applies the application timezone to local date parsing and formatting with daylight saving', async () => {
    const loaded = await loadConfigDirectory(import.meta.dirname, { processEnv: {}, preferCache: false })
    configureConfigRuntime({
      ...loaded.all,
      app: normalizeAppConfig({ timezone: 'America/New_York' }),
    })

    expect(new Date('2026-01-15T12:00:00').toISOString()).toBe('2026-01-15T17:00:00.000Z')
    expect(new Date('2026-07-15T12:00:00').toISOString()).toBe('2026-07-15T16:00:00.000Z')
    expect(new Date('2026-07-15T16:00:00Z').getHours()).toBe(12)
    expect(new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23' })
      .format(new Date('2026-07-15T16:00:00Z'))).toBe('12')
    expect(new Date('2026-07-15T12:00:00+02:00').toISOString()).toBe('2026-07-15T10:00:00.000Z')
    expect(JSON.stringify(new Date('2026-07-15T12:00:00'))).toBe('"2026-07-15T16:00:00.000Z"')
  })

  it('applies case-insensitive timezone names with daylight saving', async () => {
    const loaded = await loadConfigDirectory(import.meta.dirname, { processEnv: {}, preferCache: false })
    configureConfigRuntime({
      ...loaded.all,
      app: normalizeAppConfig({ timezone: 'america/new_york' }),
    })

    expect(new Date('2026-07-15T12:00:00').toISOString()).toBe('2026-07-15T16:00:00.000Z')
    expect(new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23' })
      .format(new Date('2026-07-15T16:00:00Z'))).toBe('12')
  })

  it.each(['Asia/Tokyo', undefined])('restores the original process timezone %s after reconfiguration and shutdown', async timezone => {
    const loaded = await loadConfigDirectory(import.meta.dirname, { processEnv: {}, preferCache: false })
    const originalTimezone = process.env.TZ
    try {
      if (timezone === undefined) delete process.env.TZ
      else process.env.TZ = timezone
      const originalOffset = new Date('2026-01-15T12:00:00Z').getTimezoneOffset()
      configureConfigRuntime({
        ...loaded.all,
        app: normalizeAppConfig({ timezone: 'America/New_York' }),
      })
      configureConfigRuntime({
        ...loaded.all,
        app: normalizeAppConfig(),
      })
      expect(new Date('2026-01-15T12:00:00').toISOString()).toBe('2026-01-15T12:00:00.000Z')
      resetConfigRuntime()
      expect(process.env.TZ).toBe(timezone)
      expect(new Date('2026-01-15T12:00:00Z').getTimezoneOffset()).toBe(originalOffset)
      resetConfigRuntime()
      expect(process.env.TZ).toBe(timezone)
    } finally {
      resetConfigRuntime()
      if (originalTimezone === undefined) delete process.env.TZ
      else process.env.TZ = originalTimezone
    }
  })
})
