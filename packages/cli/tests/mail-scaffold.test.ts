import { describe, expect, it } from 'vitest'
import { renderMailConfig, renderMailEnvFiles, renderScaffoldEnvFiles } from '../src/project/scaffold'

describe('@holo-js/cli mail scaffold', () => {
  it('excludes mail env defaults from scaffolded env files until mail is requested', () => {
    const rendered = renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
    })

    expect(rendered.env).not.toContain('MAIL_MAILER=preview')
    expect(rendered.env).not.toContain('MAIL_FROM_ADDRESS=hello@app.test')
    expect(rendered.env).not.toContain('MAIL_LOG_BODIES=false')
    expect(rendered.env).not.toContain('MAIL_HOST=127.0.0.1')
    expect(rendered.env).not.toContain('MAIL_USERNAME=')
    expect(rendered.example).not.toContain('MAIL_MAILER=')
    expect(rendered.example).not.toContain('MAIL_FROM_ADDRESS=')
    expect(rendered.example).not.toContain('MAIL_PASSWORD=')
    expect(rendered.env).toContain('DB_DRIVER=sqlite\n\nDB_URL=./storage/database.sqlite')
    expect(rendered.example).toContain('DB_DRIVER=\n\nDB_URL=')
  })

  it('includes mail env defaults when mail is requested during scaffold', () => {
    const rendered = renderScaffoldEnvFiles({
      projectName: 'Mail App',
      databaseDriver: 'sqlite',
      storageDefaultDisk: 'local',
      optionalPackages: ['mail'],
    })

    expect(rendered.env).toContain('MAIL_MAILER=preview')
    expect(rendered.env).toContain('MAIL_FROM_ADDRESS=hello@app.test')
    expect(rendered.env).toContain('MAIL_LOG_BODIES=false')
    expect(rendered.env).toContain('MAIL_HOST=127.0.0.1')
    expect(rendered.env).toContain('MAIL_USERNAME=')
    expect(rendered.example).toContain('MAIL_MAILER=')
    expect(rendered.example).toContain('MAIL_FROM_ADDRESS=')
    expect(rendered.example).toContain('MAIL_PASSWORD=')
    expect(rendered.env).toContain('DB_URL=./storage/database.sqlite\n\nMAIL_MAILER=preview')
    expect(rendered.example).toContain('DB_URL=\n\nMAIL_MAILER=')
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
