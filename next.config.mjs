/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@google/genai', 'ffmpeg-static', 'ffprobe-static'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
