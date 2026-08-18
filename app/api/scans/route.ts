import { NextResponse } from 'next/server'
import { listScans, newScan } from '@/lib/store'

export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({ scans: listScans() })
}

export async function POST() {
  const scan = newScan()
  return NextResponse.json({ id: scan.id })
}
