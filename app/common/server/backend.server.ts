import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import type { HeadersFunction } from 'react-router';

export class BackendError extends Error {
  status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}

export function routeError(error: unknown): string {
  return error instanceof BackendError ? error.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

export function publicOrigin(request: Request): string {
  return process.env.NODE_ENV === 'production' && process.env.SALESOS_PUBLIC_URL
    ? new URL(process.env.SALESOS_PUBLIC_URL).origin : new URL(request.url).origin;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== publicOrigin(request)) {
    throw new Response('요청한 사이트를 확인할 수 없습니다.', { status: 403 });
  }
}

export const routeHeaders: HeadersFunction = ({ parentHeaders, loaderHeaders, actionHeaders, errorHeaders }) => {
  const result = new Headers();
  const cookies = new Map<string, string>();
  for (const source of [parentHeaders, loaderHeaders, actionHeaders, errorHeaders]) {
    if (!source) continue;
    source.forEach((value, key) => { if (key !== 'set-cookie') result.set(key, value); });
    for (const value of source.getSetCookie()) cookies.set(value.split('=', 1)[0], value);
  }
  for (const value of cookies.values()) result.append('Set-Cookie', value);
  const cacheControl = result.get('Cache-Control') || '';
  if (!cacheControl.includes('private') || !cacheControl.includes('no-store')) result.set('Cache-Control', 'private, no-store');
  return result;
};

// Each loader/action gets its own Supabase client. Session tokens never enter loader data.
export function createBackend(request: Request, options: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; authTimeoutMs?: number } = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  const cookies = new Map(parseCookieHeader(request.headers.get('cookie') || '').map(c => [c.name, c.value]));
  let authSignal: AbortSignal | undefined;
  const authBudget = () => authSignal ??= AbortSignal.any([request.signal, AbortSignal.timeout(options.authTimeoutMs ?? 10_000)]);
  const authUnavailable = () => new BackendError('로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  const authFetch: typeof fetch = async (input, init = {}) => {
    const signal = AbortSignal.any([authBudget(), ...(init.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const response = await fetchImpl(input, { ...init, signal });
    signal.throwIfAborted();
    return response;
  };
  // The SDK retries refresh failures internally. Bound the caller's wait as well
  // as HTTP requests; later SDK retries see the aborted signal without sending.
  function withinAuthBudget<T>(operation: () => Promise<T>): Promise<T> {
    const signal = authBudget();
    if (signal.aborted) return Promise.reject(authUnavailable());
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(authUnavailable());
      signal.addEventListener('abort', aborted, { once: true });
      operation().then(
        value => { signal.removeEventListener('abort', aborted); resolve(value); },
        () => { signal.removeEventListener('abort', aborted); reject(authUnavailable()); },
      );
    });
  }
  const supabase = env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY
    ? createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        global: { fetch: authFetch },
        cookieOptions: {
          path: '/', sameSite: 'lax', httpOnly: true,
          secure: new URL(env.SALESOS_PUBLIC_URL || request.url).protocol === 'https:' && env.NODE_ENV === 'production',
        },
        cookies: {
          getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
          setAll: (values, cacheHeaders) => {
            for (const { name, value, options: cookieOptions } of values) {
              cookies.set(name, value);
              headers.append('Set-Cookie', serializeCookieHeader(name, value, cookieOptions));
            }
            for (const [name, value] of Object.entries(cacheHeaders)) headers.set(name, value);
          },
        },
      }) : null;
  let accessToken: Promise<string | null> | undefined;
  function token() {
    return accessToken ??= (async () => {
      if (env.NODE_ENV !== 'production' && env.SALESOS_DEV_MODE?.toLowerCase() === 'true' && !env.SUPABASE_SERVICE_KEY) {
        return env.SALESOS_DEV_TOKEN || 'salesos-local-dev';
      }
      if (!supabase) return null;
      const { data, error } = await withinAuthBudget(() => supabase.auth.getSession());
      if (error) {
        if (error.status === 401 || error.status === 403 || ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found'].includes(error.code || '')) return null;
        throw authUnavailable();
      }
      // This only transports the token. Python validates it and active membership for every protected API.
      return data.session?.access_token || null;
    })();
  }
  async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new BackendError('요청 경로가 올바르지 않습니다.', 400);
    const base = new URL(env.SALESOS_API_ORIGIN || 'http://127.0.0.1:8000');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new BackendError('업무 서버 설정을 확인해 주세요.');
    const url = new URL('/api' + path, base);
    const outgoing = new Headers(init.headers);
    outgoing.set('Accept', 'application/json');
    if (init.body && !outgoing.has('Content-Type')) outgoing.set('Content-Type', 'application/json');
    const credential = path === '/config' || path === '/health' ? null : await token();
    if (credential) outgoing.set('Authorization', 'Bearer ' + credential);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init, headers: outgoing, redirect: 'manual',
        signal: AbortSignal.any([request.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]),
      });
    } catch { throw new BackendError('업무 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new BackendError(typeof body?.detail === 'string' ? body.detail : '요청을 처리하지 못했습니다.', response.status);
    return body as T;
  }
  return { request: apiRequest, headers, supabase, token, hasSession: async () => Boolean(await token()) };
}
