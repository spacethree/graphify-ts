export default function middleware() {
  return null
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/teams/:path*'],
}
