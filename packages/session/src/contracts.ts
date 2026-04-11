export { defineSessionConfig } from '@holo-js/config'
export type {
  HoloSessionConfig,
  HoloSessionCookieConfig,
  NormalizedHoloSessionConfig,
  SessionCookieSameSite,
} from '@holo-js/config'
import type { NormalizedHoloSessionConfig, SessionCookieSameSite } from '@holo-js/config'

export interface CreateSessionInput {
  readonly store?: string
  readonly data?: Readonly<Record<string, unknown>>
  readonly id?: string
  readonly name?: string
  readonly value?: Readonly<Record<string, unknown>>
}

export interface ReadSessionOptions {
  readonly store?: string
}

export interface TouchSessionOptions {
  readonly store?: string
}

export interface RotateSessionOptions {
  readonly store?: string
  readonly newId?: string
}

export interface RememberTokenOptions {
  readonly store?: string
}

export interface SessionRecord {
  readonly id: string
  readonly store: string
  readonly data: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly lastActivityAt: Date
  readonly expiresAt: Date
  readonly rememberTokenHash?: string
}

export interface CookieSerializeOptions {
  readonly path?: string
  readonly domain?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: SessionCookieSameSite
  readonly partitioned?: boolean
  readonly maxAge?: number
  readonly expires?: Date
}

export interface SessionStore {
  read(sessionId: string): Promise<SessionRecord | null>
  write(record: SessionRecord): Promise<void>
  delete(sessionId: string): Promise<void>
}

export interface SessionRuntimeBindings {
  readonly config: NormalizedHoloSessionConfig
  readonly stores: Readonly<Record<string, SessionStore>>
}

export interface SessionRuntimeFacade {
  create(input?: CreateSessionInput): Promise<SessionRecord>
  read(sessionId: string, options?: ReadSessionOptions): Promise<SessionRecord | null>
  rotate(sessionId: string, options?: RotateSessionOptions): Promise<SessionRecord>
  invalidate(sessionId: string, options?: ReadSessionOptions): Promise<void>
  touch(sessionId: string, options?: TouchSessionOptions): Promise<SessionRecord | null>
  issueRememberMeToken(sessionId: string, options?: RememberTokenOptions): Promise<string>
  consumeRememberMeToken(token: string, options?: RememberTokenOptions): Promise<SessionRecord | null>
  cookie(name: string, value: string, options?: CookieSerializeOptions): string
  sessionCookie(value: string, options?: CookieSerializeOptions): string
  rememberMeCookie(value: string, options?: CookieSerializeOptions): string
}

export interface SessionCookieHelpers {
  make(name: string, value: string, options?: CookieSerializeOptions): string
  forget(name: string, options?: CookieSerializeOptions): string
}

export interface SessionFacade {
  (input?: CreateSessionInput): Promise<SessionRecord>
  create(input?: CreateSessionInput): Promise<SessionRecord>
  read(sessionId: string, options?: ReadSessionOptions): Promise<SessionRecord | null>
  rotate(sessionId: string, options?: RotateSessionOptions): Promise<SessionRecord>
  invalidate(sessionId: string, options?: ReadSessionOptions): Promise<void>
  touch(sessionId: string, options?: TouchSessionOptions): Promise<SessionRecord | null>
  issueRememberMeToken(sessionId: string, options?: RememberTokenOptions): Promise<string>
  consumeRememberMeToken(token: string, options?: RememberTokenOptions): Promise<SessionRecord | null>
  cookie(name: string, value: string, options?: CookieSerializeOptions): string
  sessionCookie(value: string, options?: CookieSerializeOptions): string
  rememberMeCookie(value: string, options?: CookieSerializeOptions): string
  cookies: SessionCookieHelpers
}
