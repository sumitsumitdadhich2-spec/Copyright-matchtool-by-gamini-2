/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@google/genai', 'ffmpeg-static', 'ffprobe-static'],
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
