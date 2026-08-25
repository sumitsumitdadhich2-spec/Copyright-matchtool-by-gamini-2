/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@google/genai', 'ffmpeg-static', 'ffprobe-static'],
  outputFileTracingIncludes: {
    '/api/scans/**': [
      './node_modules/ffmpeg-static/ffmpeg',
      './node_modules/ffprobe-static/bin/linux/x64/ffprobe',
    ],
  },
  outputFileTracingExcludes: {
    '*': ['./data/**', './public/**'],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
