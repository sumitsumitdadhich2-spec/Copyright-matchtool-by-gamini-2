/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@google/genai', 'ffmpeg-static', 'ffprobe-static'],
  // ffmpeg/ffprobe binaries are NOT bundled into serverless functions — they
  // blow up function size, prevent function merging, and push the deployment
  // over the 12-function Hobby limit. In production they are downloaded once
  // per instance from Blob storage (see lib/ffmpeg-bin.ts).
  outputFileTracingExcludes: {
    '*': [
      './data/**',
      './public/**',
      './node_modules/ffmpeg-static/**',
      './node_modules/ffprobe-static/**',
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
