import { configureMailRuntime, normalizeMailConfig, type MailJsonObject } from '../../src'
import { compileMailRegistry } from '../../src/templates'

declare module '../../src/contracts-types' {
  interface HoloMailTemplateRegistry {
    readonly 'welcome': Record<string, never>
    readonly 'fixture': MailJsonObject
  }
}

export function configureFakeMailerWithTemplates(templates: Readonly<Record<string, string>>): void {
  configureMailRuntime({
    config: normalizeMailConfig({
      default: 'fake',
      from: { email: 'noreply@example.com' },
      mailers: { fake: { driver: 'fake' } },
    }),
    environment: 'test',
    compiled: compileMailRegistry({ templates }),
  })
}
