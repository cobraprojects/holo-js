import { describe, it } from 'vitest'
import { defineSchema, field } from '@holo-js/validation'
import {
  channel,
  defineBroadcast,
  defineChannel,
  presenceChannel,
  privateChannel,
  type BroadcastDefinition,
  type BroadcastDriver,
  type BroadcastDriverName,
  type ChannelPatternParams,
  type InferChannelPresenceMember,
  type InferChannelWhisperPayload,
} from '../src'

declare module '../src/contracts' {
  interface HoloBroadcastDriverRegistry {
    readonly custom: BroadcastDriver
  }
}

describe('@holo-js/broadcast typing', () => {
  it('preserves contract typing for definitions, channel params, and whisper inference', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const definition = defineBroadcast({
      name: 'orders.updated',
      channels: [
        privateChannel('orders.{orderId}', { orderId: 'ord_1' }),
        presenceChannel('chat.{roomId}', { roomId: 'room_1' }),
        channel('dashboard'),
      ],
      payload: {
        orderId: 'ord_1',
        status: 'shipped',
      },
    })

    const typingSchema = defineSchema({
      editing: field.boolean().required(),
    })

    const presence = defineChannel('chat.{roomId}', {
      type: 'presence',
      authorize() {
        return {
          id: 'user_1',
          name: 'Ava',
        }
      },
      whispers: {
        'typing.start': typingSchema,
      },
    })

    const normalizedDefinition: BroadcastDefinition = definition
    type DefinitionAssertion = Expect<Equal<typeof normalizedDefinition, BroadcastDefinition>>
    type ParamsAssertion = Expect<Equal<ChannelPatternParams<'orders.{orderId}'>, Readonly<Record<'orderId', string>>>>
    type PresenceMember = InferChannelPresenceMember<typeof presence>
    type WhisperPayload = InferChannelWhisperPayload<typeof presence, 'typing.start'>

    const driverName: BroadcastDriverName = 'custom'
    const params: ChannelPatternParams<'orders.{orderId}.items.{itemId}'> = {
      orderId: 'ord_1',
      itemId: 'itm_1',
    }
    const member: PresenceMember = {
      id: 'user_1',
      name: 'Ava',
    }
    const whisper: WhisperPayload = {
      editing: true,
    }

    void driverName
    void normalizedDefinition
    void params
    void member
    void whisper
    void (0 as unknown as DefinitionAssertion)
    void (0 as unknown as ParamsAssertion)
  })
})
