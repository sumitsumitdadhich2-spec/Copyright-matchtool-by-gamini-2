import { type NextRequest, NextResponse } from 'next/server'
import { createUser, deleteUser, readUsers, requireAdmin, resetUserPassword, setUserDisabled } from '@/lib/users'
import { deleteUserKeys } from '@/lib/user-keys'

// All user-management endpoints are admin-only (shiva).

export async function GET() {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const users = await readUsers()
  return NextResponse.json({
    users: users.map((u) => ({
      username: u.username,
      createdAt: u.createdAt,
      disabled: Boolean(u.disabled),
    })),
  })
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { username, password } = (await request.json().catch(() => ({}))) as {
    username?: string
    password?: string
  }
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 })
  }

  const result = await createUser(username, password)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { username, disabled, password } = (await request.json().catch(() => ({}))) as {
    username?: string
    disabled?: boolean
    password?: string
  }
  if (!username) return NextResponse.json({ error: 'Username required' }, { status: 400 })

  if (typeof password === 'string') {
    const result = await resetUserPassword(username, password)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ ok: true })
  }

  if (typeof disabled === 'boolean') {
    const ok = await setUserDisabled(username, disabled)
    if (!ok) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
}

export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin()
  if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { username } = (await request.json().catch(() => ({}))) as { username?: string }
  if (!username) return NextResponse.json({ error: 'Username required' }, { status: 400 })

  const ok = await deleteUser(username)
  if (!ok) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  // Also wipe the deleted account's private API-key file in Blob.
  await deleteUserKeys(username)
  return NextResponse.json({ ok: true })
}
