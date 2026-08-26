import { type NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/session'

// Protects every API route except the auth endpoints themselves.
// Page-level protection is handled by the AuthGate client component.

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Auth endpoints must stay open so users can log in.
  if (pathname.startsWith('/api/auth/')) {
    return NextResponse.next()
  }

  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized — please log in' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/api/:path*'],
}
