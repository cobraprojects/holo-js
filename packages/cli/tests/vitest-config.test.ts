import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'

describe('@holo-js/cli vitest config', () => {
  it('runs CLI integration tests from the package test script', () => {
    expect(packageJson.scripts.test).toContain('HOLO_CLI_INCLUDE_INTEGRATION=1')
    expect(packageJson.scripts.test).toContain('tests/cli.test.ts')
    expect(packageJson.scripts['test:integration']).toContain('HOLO_CLI_INCLUDE_INTEGRATION=1')
    expect(packageJson.scripts['test:integration']).toContain('tests/cli.test.ts')
  })
})
