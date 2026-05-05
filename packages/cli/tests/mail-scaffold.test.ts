import { describe, expect, it } from 'vitest'
import { renderMailConfig, renderMailEnvFiles, renderScaffoldEnvFiles } from '../src/project/scaffold'

describe('@holo-js/cli mail scaffold', () => {
  it('includes mail env defaults in scaffolded env files', () => {
    const rendered = renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
    })

    expect(rendered.env).toContain('MAIL_MAILER=preview')
    expect(rendered.env).toContain('MAIL_FROM_ADDRESS=hello@app.test')
    expect(rendered.env).toContain('MAIL_LOG_BODIES=false')
    expect(rendered.env).toContain('MAIL_HOST=127.0.0.1')
    expect(rendered.env).toContain('MAIL_USERNAME=')
    expect(rendered.example).toContain('MAIL_MAILER=')
    expect(rendered.example).toContain('MAIL_FROM_ADDRESS=')
    expect(rendered.example).toContain('MAIL_PASSWORD=')
  })

  it('exposes a complete mail env block and matching config references', () => {
    expect(renderMailEnvFiles().env).toEqual([
      'MAIL_MAILER=preview',
      'MAIL_FROM_ADDRESS=hello@app.test',
      'MAIL_FROM_NAME=Holo App',
      'MAIL_LOG_BODIES=false',
      'MAIL_HOST=127.0.0.1',
      'MAIL_PORT=1025',
      'MAIL_SECURE=false',
      'MAIL_USERNAME=',
      'MAIL_PASSWORD=',
    ])

    const config = renderMailConfig()
    expect(config).toContain('logBodies: env(\'MAIL_LOG_BODIES\', false)')
    expect(config).toContain('host: env(\'MAIL_HOST\', \'127.0.0.1\')')
    expect(config).toContain('user: env(\'MAIL_USERNAME\') || undefined')
    expect(config).toContain('password: env(\'MAIL_PASSWORD\') || undefined')
  })
})
