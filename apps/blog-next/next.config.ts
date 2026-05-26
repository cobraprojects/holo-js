import type { NextConfig } from 'next'
import { withHolo } from '@holo-js/adapter-next/config'

const nextConfig: NextConfig = withHolo({
  experimental: {
    serverActions: {
      bodySizeLimit: '3mb' as const,
    },
  },
})

export default nextConfig
