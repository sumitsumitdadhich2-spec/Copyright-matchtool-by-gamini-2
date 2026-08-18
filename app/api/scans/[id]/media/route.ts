import fs from 'node:fs'
import path from 'node:path'
import { getScan, scanMediaDir } from '@/lib/store'

export const runtime = 'nodejs'

/** Serve uploaded videos with HTTP Range support so previews are seekable. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!getScan(id)) return new Response('Not found', { status: 404 })

  const url = new URL(req.url)
  const kind = url.searchParams.get('kind') === 'short' ? 'short' : 'movie'
  const file = path.join(scanMediaDir(id), `${kind}.mp4`)
  if (!fs.existsSync(file)) return new Response('File not found', { status: 404 })

  const stat = fs.statSync(file)
  const range = req.headers.get('range')

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/)
    if (m) {
      const start = Number(m[1])
      const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : Math.min(start + 4 * 1024 * 1024 - 1, stat.size - 1)
      if (start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } })
      const stream = fs.createReadStream(file, { start, end })
      return new Response(Readable_toWeb(stream), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1),
          'Content-Type': 'video/mp4',
        },
      })
    }
  }

  const stream = fs.createReadStream(file)
  return new Response(Readable_toWeb(stream), {
    status: 200,
    headers: {
      'Content-Length': String(stat.size),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
    },
  })
}

function Readable_toWeb(stream: fs.ReadStream): ReadableStream {
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)))
      stream.on('end', () => controller.close())
      stream.on('error', (err) => controller.error(err))
    },
    cancel() {
      stream.destroy()
    },
  })
}
