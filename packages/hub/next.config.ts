import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: [
    '@build-studio/shared',
    '@build-studio/project-server',
  ],
}

export default nextConfig
