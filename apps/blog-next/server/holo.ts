import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createNextHoloHelpers } from '@holo-js/adapter-next/runtime'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const holo = createNextHoloHelpers({ projectRoot })
