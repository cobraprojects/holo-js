import {
  cookie,
  consumeRememberMeToken,
  cookies,
  createSession,
  invalidateSession,
  issueRememberMeToken,
  readSession,
  rememberMeCookie,
  rotateSession,
  sessionCookie,
  touchSession,
} from './runtime'

export { defineSessionConfig } from './contracts'
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
    read: readSession,
    rotate: rotateSession,
    invalidate: invalidateSession,
    touch: touchSession,
    issueRememberMeToken,
    consumeRememberMeToken,
    cookie,
    sessionCookie,
    rememberMeCookie,
    cookies,
  },
) as SessionFacade

export default session
