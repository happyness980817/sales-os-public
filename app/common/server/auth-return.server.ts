import { createCookie } from 'react-router';

const returnCookie = createCookie('salesos_return_to', {
  path: '/', httpOnly: true, sameSite: 'lax', maxAge: 600, secure: process.env.NODE_ENV === 'production',
});

// Only local application pages can be resumed after signing in.
export function safeAuthReturn(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/chat';
  try {
    const url = new URL(value, 'https://salesos.invalid');
    if (url.origin !== 'https://salesos.invalid') return '/chat';
    const project = /^\/projects(?:\/prj_[a-f0-9]{32}(?:\/chat)?)?$/.test(url.pathname);
    const page = /^\/(chat|connections(?:\/[a-z_]+)?|jobs|files|materials|settings)$/.test(url.pathname);
    if (!project && !page) return '/chat';
    const thread = url.searchParams.get('thread');
    const chat = url.pathname === '/chat' || url.pathname.endsWith('/chat');
    return url.pathname + (chat && thread && /^[a-zA-Z0-9_-]{1,120}$/.test(thread) ? '?thread=' + encodeURIComponent(thread) : '');
  } catch { return '/chat'; }
}

export async function saveAuthReturn(headers: Headers, value: unknown) {
  headers.append('Set-Cookie', await returnCookie.serialize(safeAuthReturn(value)));
}

export async function takeAuthReturn(request: Request, headers: Headers) {
  const value = await returnCookie.parse(request.headers.get('Cookie'));
  headers.append('Set-Cookie', await returnCookie.serialize('', { maxAge: 0 }));
  return safeAuthReturn(value);
}
