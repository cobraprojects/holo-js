import type {
  BelongsToManyRelationDefinition,
  BelongsToRelationDefinition,
  EmptyScopeMap,
  GeneratedSchemaTable,
  HasManyRelationDefinition,
  ModelReference,
  RelationMap,
} from '@holo-js/db'

type CategoryTable = GeneratedSchemaTable<'categories'>
type CommentTable = GeneratedSchemaTable<'comments'>
type PostTable = GeneratedSchemaTable<'posts'>
type PostTagTable = GeneratedSchemaTable<'post_tags'>
type TagTable = GeneratedSchemaTable<'tags'>
type UserTable = GeneratedSchemaTable<'users'>

interface CategoryRelations extends RelationMap {
  readonly posts: HasManyRelationDefinition<PostModel>
}

interface CommentRelations extends RelationMap {
  readonly post: BelongsToRelationDefinition<PostModel>
  readonly user: BelongsToRelationDefinition<UserModel>
}

interface PostRelations extends RelationMap {
  readonly user: BelongsToRelationDefinition<UserModel>
  readonly category: BelongsToRelationDefinition<CategoryModel>
  readonly tags: BelongsToManyRelationDefinition<TagModel, PostTagTable>
  readonly comments: HasManyRelationDefinition<CommentModel>
}

interface TagRelations extends RelationMap {
  readonly posts: BelongsToManyRelationDefinition<PostModel, PostTagTable>
}

interface UserRelations extends RelationMap {
  readonly posts: HasManyRelationDefinition<PostModel>
  readonly comments: HasManyRelationDefinition<CommentModel>
}

type CategoryModel = ModelReference<CategoryTable, EmptyScopeMap, CategoryRelations>
type CommentModel = ModelReference<CommentTable, EmptyScopeMap, CommentRelations>
type PostModel = ModelReference<PostTable, EmptyScopeMap, PostRelations>
type TagModel = ModelReference<TagTable, EmptyScopeMap, TagRelations>
type UserModel = ModelReference<UserTable, EmptyScopeMap, UserRelations>

declare module '@holo-js/db' {
  interface RegisteredModels {
    Category: CategoryModel
    Comment: CommentModel
    Post: PostModel
    Tag: TagModel
    User: UserModel
  }
}
