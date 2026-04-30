import { getHomePageData } from '../../lib/blog'

export default defineEventHandler(async () => await getHomePageData())
