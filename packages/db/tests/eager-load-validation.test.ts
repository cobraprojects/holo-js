import { describe, it } from 'vitest'
import {
  belongsTo,
  column,
  hasMany,
  hasOne,
  morphMany,
  morphOne,
  morphTo,
  type Entity,
  type ModelQueryBuilder,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

type IsEqual<A, B>
  = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false

type Assert<T extends true> = T

describe('eager-load path validation and morph relation typing', () => {
  it('rejects invalid nested paths and correctly types morph relations', () => {
    // --- Schema ---
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineTable('posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string(),
    })
    const comments = defineTable('comments', {
      id: column.id(),
      post_id: column.integer(),
      body: column.text(),
    })
    const tags = defineTable('tags', {
      id: column.id(),
      name: column.string(),
    })
    const images = defineTable('images', {
      id: column.id(),
      imageable_type: column.string(),
      imageable_id: column.integer(),
      url: column.string(),
    })
    const profiles = defineTable('profiles', {
      id: column.id(),
      user_id: column.integer(),
      bio: column.text(),
    })

    // --- Models ---
    const Tag = defineModelFromTable(tags)
    const Comment = defineModelFromTable(comments, {
      relations: {
        tags: hasMany(() => Tag, 'post_id'),
      },
    })
    const Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable', 'imageable_type', 'imageable_id'),
      },
    })
    const Profile = defineModelFromTable(profiles)
    const Post = defineModelFromTable(posts, {
      relations: {
        comments: hasMany(() => Comment, 'post_id'),
        images: morphMany(() => Image, 'imageable', 'imageable_type', 'imageable_id'),
      },
    })
    const User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'user_id'),
        profile: hasOne(() => Profile, 'user_id'),
        avatar: morphOne(() => Image, 'imageable', 'imageable_type', 'imageable_id'),
      },
    })

    type UserRelations = typeof User.definition.relations
    type PostRelations = typeof Post.definition.relations

    if (false) {
      // =====================================================================
      // 1. VALID NESTED PATHS — should compile
      // =====================================================================

      // One level deep
      void User.with('posts')
      void User.query().with('posts')

      // Two levels deep
      void User.with('posts.comments')
      void User.query().with('posts.comments')

      // Three levels deep
      void User.with('posts.comments.tags')
      void User.query().with('posts.comments.tags')

      // Morph relation at root (morphOne)
      void User.with('avatar')

      // Morph relation nested under a regular relation
      void User.with('posts.images')

      // =====================================================================
      // 2. INVALID NESTED PATHS — should NOT compile
      // =====================================================================

      // @ts-expect-error invalid second segment
      User.with('posts.missing')

      // @ts-expect-error invalid second segment on query builder
      User.query().with('posts.missing')

      // @ts-expect-error invalid third segment
      User.with('posts.comments.missing')

      // @ts-expect-error invalid root
      User.with('missing')

      // @ts-expect-error invalid root with nested
      User.with('missing.anything')

      const entity = undefined as unknown as Entity<typeof users, UserRelations>

      // @ts-expect-error invalid on load()
      entity.load('posts.missing')

      // @ts-expect-error invalid nested on load()
      entity.load('posts.comments.missing')

      // =====================================================================
      // 3. MORPH RELATION TYPING
      // =====================================================================

      // morphTo nested paths are allowed (runtime resolves the target)
      const imageEntity = undefined as unknown as Entity<typeof images, typeof Image.definition.relations>
      void Image.with('imageable.whatever')
      void imageEntity.load('imageable.whatever')

      // morphOne at root resolves to Entity | null
      const q4m = User.query().with('avatar')
      type R4m = NonNullable<Awaited<ReturnType<typeof q4m.first>>>
      const r4mAvatar: Assert<IsEqual<R4m['avatar'], Entity<typeof images, typeof Image.definition.relations> | null>> = true
      void r4mAvatar

      // morphMany nested under hasMany resolves to Entity[]
      const q5m = User.query().with('posts.images')
      type R5m = NonNullable<Awaited<ReturnType<typeof q5m.first>>>
      type R5mPost = R5m['posts'][number]
      const r5mImages: Assert<IsEqual<R5mPost['images'], Entity<typeof images, typeof Image.definition.relations>[]>> = true
      void r5mImages

      // morphOne nested path (avatar.imageable) — morphTo resolves to untyped entity
      void User.with('avatar.imageable')

      // @ts-expect-error morphOne with invalid nested path should be rejected
      User.with('avatar.missing')

      // loadMorph accepts morphTo relation name
      void imageEntity.loadMorph('imageable', { User: 'posts' })

      // =====================================================================
      // 4. VALID NESTED EAGER LOAD TYPES RESOLVE CORRECTLY
      // =====================================================================

      // with('posts') → posts is Entity<PostsTable>[]
      const q1 = User.query().with('posts')
      type R1 = NonNullable<Awaited<ReturnType<typeof q1.first>>>
      const r1Posts: Assert<IsEqual<R1['posts'], Entity<typeof posts, PostRelations>[]>> = true
      void r1Posts

      // with('posts.comments') → posts[n].comments is Entity<CommentsTable>[]
      const q2 = User.query().with('posts.comments')
      type R2 = NonNullable<Awaited<ReturnType<typeof q2.first>>>
      type R2Post = R2['posts'][number]
      type R2Comments = R2Post['comments']
      const r2Comments: Assert<IsEqual<R2Comments, Entity<typeof comments, typeof Comment.definition.relations>[]>> = true
      void r2Comments

      // with('profile') → profile is Entity<ProfilesTable> | null
      const q3 = User.query().with('profile')
      type R3 = NonNullable<Awaited<ReturnType<typeof q3.first>>>
      const r3Profile: Assert<IsEqual<R3['profile'], Entity<typeof profiles> | null>> = true
      void r3Profile

      // with('avatar') → morphOne resolves as Entity | null
      const q4 = User.query().with('avatar')
      type R4 = NonNullable<Awaited<ReturnType<typeof q4.first>>>
      const r4Avatar: Assert<IsEqual<R4['avatar'], Entity<typeof images, typeof Image.definition.relations> | null>> = true
      void r4Avatar

      // with('posts.images') → morphMany resolves as Entity[]
      const q5 = User.query().with('posts.images')
      type R5 = NonNullable<Awaited<ReturnType<typeof q5.first>>>
      type R5Post = R5['posts'][number]
      const r5Images: Assert<IsEqual<R5Post['images'], Entity<typeof images, typeof Image.definition.relations>[]>> = true
      void r5Images

      // =====================================================================
      // 5. load() ALSO RESOLVES NESTED TYPES
      // =====================================================================

      const user = undefined as unknown as Entity<typeof users, UserRelations>

      type LoadPosts = Awaited<ReturnType<typeof user.load<readonly ['posts']>>>
      const loadPosts: Assert<IsEqual<LoadPosts['posts'], Entity<typeof posts, PostRelations>[]>> = true
      void loadPosts

      type LoadNested = Awaited<ReturnType<typeof user.load<readonly ['posts.comments']>>>
      type LoadNestedPost = LoadNested['posts'][number]
      const loadNestedComments: Assert<IsEqual<LoadNestedPost['comments'], Entity<typeof comments, typeof Comment.definition.relations>[]>> = true
      void loadNestedComments

      // load() on morphOne relation
      type LoadAvatar = Awaited<ReturnType<typeof user.load<readonly ['avatar']>>>
      const loadAvatar: Assert<IsEqual<LoadAvatar['avatar'], Entity<typeof images, typeof Image.definition.relations> | null>> = true
      void loadAvatar

      // load() with dotted path through morphMany
      type LoadPostImages = Awaited<ReturnType<typeof user.load<readonly ['posts.images']>>>
      type LoadPostImagesPost = LoadPostImages['posts'][number]
      const loadPostImages: Assert<IsEqual<LoadPostImagesPost['images'], Entity<typeof images, typeof Image.definition.relations>[]>> = true
      void loadPostImages

      // =====================================================================
      // 6. toJSON() SERIALIZES LOADED RELATIONS
      // =====================================================================

      const q6 = User.query().with('posts.comments')
      type R6 = NonNullable<Awaited<ReturnType<typeof q6.first>>>
      type R6JSON = ReturnType<R6['toJSON']>
      type R6PostJSON = R6JSON['posts'][number]
      const r6PostTitle: Assert<IsEqual<R6PostJSON['title'], string>> = true
      type R6CommentJSON = R6PostJSON['comments'][number]
      const r6CommentBody: Assert<IsEqual<R6CommentJSON['body'], string>> = true
      void r6PostTitle
      void r6CommentBody

      // =====================================================================
      // 7. load() WIDENS toJSON() WITH NEW RELATIONS
      // =====================================================================

      // with('posts') produces toJSON() that includes posts
      const userWithPosts = undefined as unknown as NonNullable<Awaited<ReturnType<typeof q1.first>>>
      type WithPostsJSON = ReturnType<typeof userWithPosts.toJSON>
      type WithPostsJSONPost = WithPostsJSON['posts'][number]
      const wpTitle: Assert<IsEqual<WithPostsJSONPost['title'], string>> = true
      void wpTitle

      // load('profile') on that entity: both entity props and toJSON include profile
      type AfterLoad = Awaited<ReturnType<typeof userWithPosts.load<readonly ['profile']>>>
      // entity properties: both posts and profile are present
      const afterLoadPosts: Assert<IsEqual<AfterLoad['posts'], Entity<typeof posts, PostRelations>[]>> = true
      const afterLoadProfile: Assert<IsEqual<AfterLoad['profile'], Entity<typeof profiles> | null>> = true
      void afterLoadPosts
      void afterLoadProfile

      // toJSON() from with('posts') is preserved via this
      type AfterLoadJSON = ReturnType<AfterLoad['toJSON']>
      type AfterLoadJSONPost = AfterLoadJSON['posts'][number]
      const alTitle: Assert<IsEqual<AfterLoadJSONPost['title'], string>> = true

      // toJSON() also includes the newly loaded profile
      type AfterLoadJSONProfile = AfterLoadJSON['profile']
      const alBio: Assert<IsEqual<NonNullable<AfterLoadJSONProfile>['bio'], string>> = true
      void alBio

      // load() on a bare entity (no prior with) also widens toJSON
      type BareLoad = Awaited<ReturnType<typeof user.load<readonly ['posts']>>>
      type BareLoadJSON = ReturnType<BareLoad['toJSON']>
      type BareLoadJSONPost = BareLoadJSON['posts'][number]
      const blTitle: Assert<IsEqual<BareLoadJSONPost['title'], string>> = true
      void blTitle
      void alTitle

      // collection.load() adds the newly loaded relation on collection items
      const collectionWithPosts = undefined as unknown as Awaited<ReturnType<typeof q1.get>>
      void collectionWithPosts.load('profile')
    }
  })
})
