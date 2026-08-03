import {
  cookie,
  consumeRememberMeToken,
  cookies,
  createSession,
  flashSession,
  invalidateSession,
  issueRememberMeToken,
  readSession,
  rememberMeCookie,
  rotateSession,
  sessionCookie,
  touchSession,
  takeSession,
  writeSession,
} from './runtime'

export {
  DEFAULT_SESSION_ABSOLUTE_LIFETIME,
  DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_SESSION_COOKIE_PATH,
  DEFAULT_SESSION_COOKIE_SAME_SITE,
  DEFAULT_SESSION_DATABASE_CONNECTION,
  DEFAULT_SESSION_DATABASE_TABLE,
  DEFAULT_SESSION_DRIVER,
  DEFAULT_SESSION_FILE_PATH,
  DEFAULT_SESSION_IDLE_TIMEOUT,
  DEFAULT_SESSION_REMEMBER_ME_LIFETIME,
  defineSessionConfig,
  holoSessionDefaults,
  normalizeSessionConfig,
} from './config'
export type {
  CookieSerializeOptions,
  CreateSessionInput,
  HoloSessionConfig,
  HoloSessionCookieConfig,
  NormalizedHoloSessionConfig,
  ReadSessionOptions,
  RememberTokenOptions,
  RotateSessionOptions,
  SessionCookieHelpers,
  SessionFacade,
  SessionCookieSameSite,
  SessionRecord,
  SessionRuntimeBindings,
  SessionRuntimeFacade,
  SessionStore,
  SessionStoreTakeResult,
  TouchSessionOptions,
} from './contracts'
import type {
  CreateSessionInput,
  SessionFacade,
} from './contracts'
export {
  cookie,
  configureSessionRuntime,
  consumeRememberMeToken,
  cookies,
  createSession,
  flashSession,
  getSessionRuntime,
  invalidateSession,
  issueRememberMeToken,
  parseCookieHeader,
  readSession,
  rememberMeCookie,
  resetSessionRuntime,
  rotateSession,
  serializeCookie,
  sessionCookie,
  sessionRuntimeInternals,
  touchSession,
  takeSession,
  writeSession,
} from './runtime'
export {
  createDatabaseSessionStore,
} from './drivers/database'
export type {
  SessionDatabaseDriverAdapter,
} from './drivers/database'
export {
  createFileSessionStore,
  fileSessionDriverInternals,
} from './drivers/file'
export {
  createRedisSessionStore,
} from './drivers/redis'
export type {
  SessionRedisDriverAdapter,
} from './drivers/redis'

const session = Object.assign(
  (input?: CreateSessionInput) => createSession(input),
  {
    create: createSession,
    write: writeSession,
    read: readSession,
    rotate: rotateSession,
    invalidate: invalidateSession,
    touch: touchSession,
    issueRememberMeToken,
    consumeRememberMeToken,
    flash: flashSession,
    take: takeSession,
    cookie,
    sessionCookie,
    rememberMeCookie,
    cookies,
  },
) as SessionFacade

export default session
