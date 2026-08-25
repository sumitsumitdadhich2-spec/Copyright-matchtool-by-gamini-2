import { NextResponse } from 'next/server'
import { listScans, newScan, pruneOldScans, MAX_SCANS, SCANS_DIR } from '@/lib/store'
import { restoreScansFromBlob } from '@/lib/scan-blob'

export const runtime = 'nodejs'

export async function GET() {
  // After a cold start /tmp is empty — pull scan records back from Blob first.
  await restoreScansFromBlob(SCANS_DIR)
  return NextResponse.json({ scans: listScans() })
}

export async function POST() {
  await restoreScansFromBlob(SCANS_DIR)
  const scan = newScan()
  // Keep at most MAX_SCANS scans: creating the 5th removes the oldest one
  // (its JSON record, its local video files, and its Blob backup).
  const deleted = pruneOldScans(MAX_SCANS)
  return NextResponse.json({ id: scan.id, deleted, maxScans: MAX_SCANS })
}
