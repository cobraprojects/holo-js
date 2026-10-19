import assert from 'node:assert/strict'
import { once } from 'node:events'

export async function assertExampleAppBroadcastTransactions(DB, broadcastRaw, runMaintenance) {
  const socket = new WebSocket(`ws://${process.env.BROADCAST_HOST}:${process.env.BROADCAST_PORT}/app/${process.env.BROADCAST_APP_KEY}`)
  const messages = []
  socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
  const receive = async event => {
    while (!messages.some(message => message.event === event)) {
      await once(socket, 'message', { signal: AbortSignal.timeout(5000) })
    }
    return messages.filter(message => message.event === event).map(message => JSON.parse(message.data))
  }
  const send = (event, value) => broadcastRaw({ event, channels: ['native.transactions'], payload: { value } })
  try {
    await receive('pusher:connection_established')
    socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: 'native.transactions' } }))
    await receive('pusher_internal:subscription_succeeded')
    await DB.transaction(async () => {
      await send('native.committed', 'committed').afterCommit()
      await send('native.before-commit', 'barrier')
      await receive('native.before-commit')
      assert.ok(!messages.some(message => message.event === 'native.committed'))
    })
    assert.deepEqual(await receive('native.committed'), [{ value: 'committed' }])
    await assert.rejects(DB.transaction(async () => {
      await send('native.rolled-back', 'rolled back').afterCommit()
      await send('native.before-rollback', 'barrier')
      await receive('native.before-rollback')
      assert.ok(!messages.some(message => message.event === 'native.rolled-back'))
      throw new Error('Rollback native broadcast')
    }), /Rollback native broadcast/)
    await send('native.after-rollback', 'barrier')
    await receive('native.after-rollback')
    assert.ok(!messages.some(message => message.event === 'native.rolled-back'))
    const pending = () => DB.table('jobs').where('queue', 'native-broadcast').count()
    await DB.transaction(async () => {
      await send('native.queued', 'queued after commit').onConnection('database').onQueue('native-broadcast').afterCommit()
      assert.equal(await pending(), 0)
    })
    assert.equal(await pending(), 1)
    const output = runMaintenance('queue:work', '--once', '--connection', 'database', '--queue', 'native-broadcast')
    assert.match(output, /processed=1 released=0 failed=0/)
    assert.deepEqual(await receive('native.queued'), [{ value: 'queued after commit' }])
    assert.equal(await pending(), 0)
    await assert.rejects(DB.transaction(async () => {
      await send('native.queued-rollback', 'discarded').onConnection('database').onQueue('native-broadcast').afterCommit()
      assert.equal(await pending(), 0)
      throw new Error('Rollback native queued broadcast')
    }), /Rollback native queued broadcast/)
    assert.equal(await pending(), 0)
    await send('native.immediate', 'outside transaction').afterCommit()
    assert.deepEqual(await receive('native.immediate'), [{ value: 'outside transaction' }])
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, 'close')
      socket.close()
      await closed
    }
  }
}
