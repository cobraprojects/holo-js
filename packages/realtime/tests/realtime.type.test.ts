import { describe, expectTypeOf, it } from 'vitest'
import { field, schema } from '@holo-js/validation'
import {
  mutation,
  query,
  type RealtimeArgsFor,
  type RealtimeAuthState,
  type RealtimeResultFor,
} from '../src/index'

const listPosts = query({
  args: schema({
    limit: field.number().integer().default(10),
  }),
  access: 'public',
  handler: async ({ args, auth }) => {
    expectTypeOf(args).toEqualTypeOf<{ limit: number }>()
    expectTypeOf(auth).toEqualTypeOf<RealtimeAuthState | null>()

    return [{
      id: 1,
      title: 'First',
    }]
  },
})

const createPost = mutation({
  args: schema({
    title: field.string().required(),
  }),
  access: 'authenticated',
  handler: async ({ args, auth }) => {
    expectTypeOf(args).toEqualTypeOf<{ title: string }>()
    expectTypeOf(auth).toEqualTypeOf<RealtimeAuthState>()

    return {
      id: auth.user.id,
      title: args.title,
    }
  },
})

describe('@holo-js/realtime type inference', () => {
  it('preserves args, auth, result, and definition types through the user API', () => {
    expectTypeOf(listPosts.kind).toEqualTypeOf<'query'>()
    expectTypeOf(createPost.kind).toEqualTypeOf<'mutation'>()
    expectTypeOf<RealtimeArgsFor<typeof listPosts>>().toEqualTypeOf<{ limit: number }>()
    expectTypeOf<RealtimeResultFor<typeof listPosts>>().toEqualTypeOf<{ id: number, title: string }[]>()
    expectTypeOf<ReturnType<typeof listPosts>>().toEqualTypeOf<{ id: number, title: string }[]>()
    expectTypeOf<RealtimeArgsFor<typeof createPost>>().toEqualTypeOf<{ title: string }>()
    expectTypeOf<RealtimeResultFor<typeof createPost>>().toEqualTypeOf<{ id: string | number | undefined, title: string }>()
    expectTypeOf<ReturnType<typeof createPost>>().toEqualTypeOf<Promise<{ id: string | number | undefined, title: string }>>()
  })
})
