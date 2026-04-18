import { describe, it } from 'vitest'
import {
  configureSecurityClient,
  getSecurityClientConfig,
  type SecurityClientBindings,
  type SecurityClientConfig,
} from '../src/client'

describe('@holo-js/security client typing', () => {
  it('preserves typed client config inference without manual generics', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const bindings: SecurityClientBindings = {
      config: {
        csrf: {
          field: '_csrf',
          cookie: 'csrf-token',
        },
      },
    }

    const fieldOnlyBindings: SecurityClientBindings = {
      config: {
        csrf: {
          field: '_csrf',
        },
      },
    }
    const cookieOnlyBindings: SecurityClientBindings = {
      config: {
        csrf: {
          cookie: 'csrf-token',
        },
      },
    }

    configureSecurityClient(bindings)
    configureSecurityClient(fieldOnlyBindings)
    configureSecurityClient(cookieOnlyBindings)

    const config = getSecurityClientConfig()

    type ConfigAssertion = Expect<Equal<typeof config, SecurityClientConfig>>

    const fieldName: string = config.csrf.field
    const cookieName: string = config.csrf.cookie

    void fieldName
    void cookieName
    void (0 as unknown as ConfigAssertion)
  })
})
