// Vercel Routing Middleware: puts every path (UI and API) behind HTTP Basic auth when
// APICALL_USER and APICALL_PASSWORD are set in the project's environment variables.
import { next } from '@vercel/functions';

export const config = { matcher: '/:path*' };

export default function middleware(request) {
  const user = process.env.APICALL_USER || '';
  const password = process.env.APICALL_PASSWORD || '';
  if (!user || !password) return next();
  const header = request.headers.get('authorization') || '';
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (m) {
    const decoded = atob(m[1]);
    const i = decoded.indexOf(':');
    if (i >= 0 && decoded.slice(0, i) === user && decoded.slice(i + 1) === password) return next();
  }
  return new Response('Authentication required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="ApiCall Runner", charset="UTF-8"' },
  });
}
