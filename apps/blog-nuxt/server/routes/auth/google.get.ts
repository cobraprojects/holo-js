import { redirect } from '@holo-js/auth-social'

import { toWebRequest } from '../../lib/request'

export default defineEventHandler((event) => {
  return redirect('google', toWebRequest(event))
})
