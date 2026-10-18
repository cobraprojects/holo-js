import { ip } from '@holo-js/security'

export default defineEventHandler(event => ({ address: ip(toWebRequest(event)) }))
