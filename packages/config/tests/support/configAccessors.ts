import {
  createConfigAccessors,
  type HoloConfigMap,
  type HoloConfigRegistry,
} from '../../src'

type ServicesFixtureConfig = {
  readonly mailgun: {
    readonly secret: string
  }
}

const defaultConfigRegistry = {
  app: {} as HoloConfigRegistry['app'],
  database: {} as HoloConfigRegistry['database'],
  redis: {} as HoloConfigRegistry['redis'],
  cache: {} as HoloConfigRegistry['cache'],
  cors: {} as HoloConfigRegistry['cors'],
  storage: {} as HoloConfigRegistry['storage'],
  queue: {} as HoloConfigRegistry['queue'],
  broadcast: {} as HoloConfigRegistry['broadcast'],
  mail: {} as HoloConfigRegistry['mail'],
  notifications: {} as HoloConfigRegistry['notifications'],
  media: {} as HoloConfigRegistry['media'],
  session: {} as HoloConfigRegistry['session'],
  security: {} as HoloConfigRegistry['security'],
  auth: {} as HoloConfigRegistry['auth'],
  services: {
    mailgun: {
      secret: 'secret',
    },
  },
} satisfies HoloConfigRegistry & { readonly services: ServicesFixtureConfig }

export function createConfigAccessorFixture<TOverrides extends HoloConfigMap>(
  overrides: TOverrides,
) {
  return createConfigAccessors({
    ...defaultConfigRegistry,
    ...overrides,
  })
}
