import { expect, it } from 'vitest'
import { responseCookieInternals } from '../src'

it('preserves cookie attributes when handing serialized cookies to native framework setters', () => {
  expect(responseCookieInternals.parseResponseCookie('session=guest; Path=/')).toEqual({
    name: 'session',
    value: 'guest',
    options: { path: '/', secure: false, httpOnly: false },
  })
  expect(responseCookieInternals.parseResponseCookie('session=remembered; Path=/admin; Domain=app.test; Max-Age=600; Secure; HttpOnly; SameSite=Strict; Partitioned')).toEqual({
    name: 'session',
    value: 'remembered',
    options: { path: '/admin', domain: 'app.test', maxAge: 600, secure: true, httpOnly: true, sameSite: 'strict', partitioned: true },
  })
})
