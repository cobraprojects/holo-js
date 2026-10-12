import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function authenticatorCode(secret, counter) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...secret].map(character => {
    const value = alphabet.indexOf(character)
    assert.ok(value >= 0, 'enrollment must supply a valid authenticator secret')
    return value.toString(2).padStart(5, '0')
  }).join('')
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(byte => Number.parseInt(byte, 2)))
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest.at(-1) & 15
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

export async function assertExampleAppAuthStorageBehavior(projectRoot, DB) {
  const require = createRequire(join(projectRoot, 'package.json'))
  const auth = await import(pathToFileURL(require.resolve('@holo-js/auth')).href)
  const { getSessionRuntime } = await import(pathToFileURL(require.resolve('@holo-js/session')).href)
  const bindings = auth.authRuntimeInternals.getRuntimeBindings()
  const password = `Native-password-${randomUUID()}`
  const email = `native-auth-${randomUUID()}@app.test`
  const sessions = new Set()
  let userId
  auth.configureAuthRuntime({ ...bindings, config: auth.defineAuthConfig({ ...bindings.config, multiFactor: true }) })
  try {
    await bindings.context.run(async () => {
      const user = await bindings.providers.users.create({ name: 'Native authentication', email, password: await auth.hashPassword(password), email_verified_at: new Date() })
      userId = bindings.providers.users.getId(user)
      const token = await auth.tokens.create(user, { name: 'Native access', abilities: ['posts.*'] })
      const sibling = await auth.tokens.create(user, { name: 'Sibling access', abilities: ['*'] })
      const stored = await DB.table('personal_access_tokens').where('id', token.id).first()
      assert.equal(stored.token_hash, `sha256$${createHash('sha256').update(token.plainTextToken.split('.').at(-1)).digest('hex')}`)
      assert.equal(await auth.tokens.can(token.plainTextToken, 'posts.read'), true)
      assert.equal(await auth.tokens.can(token.plainTextToken, 'users.delete'), false)
      assert.equal(await auth.tokens.authenticate(`${token.plainTextToken}tampered`), null)
      assert.equal((await auth.tokens.authenticate(token.plainTextToken)).email, email)
      assert.deepEqual((await auth.tokens.list(user)).map(value => value.id).sort(), [token.id, sibling.id].sort())
      assert.equal(await auth.tokens.revokeAll(user), 2)
      assert.equal(await auth.tokens.authenticate(token.plainTextToken), null)
      assert.equal(await DB.table('personal_access_tokens').where('user_id', String(userId)).count(), 0)

      const first = await auth.login({ email, password })
      sessions.add(first.sessionId)
      assert.ok(await getSessionRuntime().read(first.sessionId))
      const enrollment = await auth.multiFactor.beginEnrollment()
      const counter = Math.floor(Date.now() / 30_000)
      const recovery = await auth.multiFactor.confirmEnrollment({ code: authenticatorCode(enrollment.manualKey, counter - 1) })
      assert.equal(recovery.recoveryCodes.length, 8)
      assert.deepEqual(await auth.multiFactor.status(), { enabled: true, recoveryCodesRemaining: 8 })
      const credential = await DB.table('auth_multi_factor_credentials').where('provider', 'users').where('user_id', String(userId)).first()
      assert.ok(credential)
      assert.ok(!credential.encrypted_secret.includes(enrollment.manualKey))
      assert.ok(!JSON.stringify(credential.recovery_code_hashes).includes(recovery.recoveryCodes[0]))
      await auth.logout()
      assert.equal(await getSessionRuntime().read(first.sessionId), null)

      const pending = await auth.login({ email, password })
      sessions.add(pending.sessionId)
      assert.ok(pending.multiFactorChallenge)
      assert.equal(await auth.user(), null)
      const code = authenticatorCode(enrollment.manualKey, Math.floor(Date.now() / 30_000))
      const established = await auth.multiFactor.challenge({ code })
      sessions.add(established.sessionId)
      assert.notEqual(established.sessionId, pending.sessionId)
      assert.equal(await getSessionRuntime().read(pending.sessionId), null)
      assert.equal((await auth.user()).email, email)
      await auth.logout()

      const replay = await auth.login({ email, password })
      sessions.add(replay.sessionId)
      await assert.rejects(auth.multiFactor.challenge({ code }), { code: 'multi_factor_code_invalid' })
      const recoveryAttempts = await Promise.allSettled([
        auth.multiFactor.recover({ code: recovery.recoveryCodes[0] }),
        auth.multiFactor.recover({ code: recovery.recoveryCodes[0] }),
      ])
      const winners = recoveryAttempts.filter(result => result.status === 'fulfilled')
      assert.equal(winners.length, 1, 'a persisted recovery code must be consumed once across concurrent attempts')
      sessions.add(winners[0].value.sessionId)
      assert.deepEqual(await auth.multiFactor.status(), { enabled: true, recoveryCodesRemaining: 7 })
      await auth.logout()
      const reused = await auth.login({ email, password })
      sessions.add(reused.sessionId)
      await assert.rejects(auth.multiFactor.recover({ code: recovery.recoveryCodes[0] }), { code: 'multi_factor_code_invalid' })
    })
  } finally {
    auth.configureAuthRuntime(bindings)
    for (const sessionId of sessions) await getSessionRuntime().invalidate(sessionId)
    if (userId !== undefined) {
      await DB.table('auth_multi_factor_credentials').where('provider', 'users').where('user_id', String(userId)).delete()
      await DB.table('personal_access_tokens').where('provider', 'users').where('user_id', String(userId)).delete()
      await DB.table('users').where('id', userId).delete()
    }
  }
}
