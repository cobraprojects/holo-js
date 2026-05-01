import type { NextConfig } from 'next'
import { withHolo } from '@holo-js/adapter-next/config'

const nextConfig: NextConfig = withHolo({
  /* config options here */
})

export default nextConfig
