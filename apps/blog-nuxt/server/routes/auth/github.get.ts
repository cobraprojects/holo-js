import { redirect } from '@holo-js/auth-social'

export default defineEventHandler((event) => {
  return redirect('github', event)
})
