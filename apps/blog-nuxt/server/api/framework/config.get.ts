import { useConfig } from '@holo-js/config'

export default defineEventHandler(() => ({ name: useConfig('app').name }))
