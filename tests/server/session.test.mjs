import assert from 'node:assert/strict';
import test from 'node:test';
import { BackendError, createBackend, assertSameOrigin, routeHeaders } from '../../app/common/server/backend.server.ts';

const env = { NODE_ENV: 'production', SUPABASE_URL: 'https://test-project.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test-public-key', SUPABASE_SERVICE_KEY: 'must-never-be-forwarded', SALESOS_PUBLIC_URL: 'https://sales.test', SALESOS_API_ORIGIN: 'http://127.0.0.1:8000' };
function session(owner, expired = false) {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -300 : 3600);
  const payload = Buffer.from(JSON.stringify({ sub: owner, exp })).toString('base64url');
  return { access_token: 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.test-signature', refresh_token: 'refresh-' + owner, expires_at: exp, expires_in: 3600, token_type: 'bearer', user: { id: owner, aud: 'authenticated', role: 'authenticated', email: owner + '@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
}
function requestFor(value) {
  const cookie = 'sb-test-project-auth-token=base64-' + Buffer.from(JSON.stringify(value)).toString('base64url');
  return new Request('https://sales.test/materials', { headers: { cookie } });
}

test('SSR requests keep employee cookies isolated and only forward their own bearer', async () => {
  const a = session('employee-a'), b = session('employee-b');
  const seen = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url.origin, 'http://127.0.0.1:8000');
    assert.equal(init.headers.has('cookie'), false);
    assert.equal(init.headers.has('apikey'), false);
    seen.push(init.headers.get('authorization'));
    return Response.json({ items: [] });
  };
  const first = createBackend(requestFor(a), { env, fetchImpl });
  const second = createBackend(requestFor(b), { env, fetchImpl });
  assert.equal(await first.hasSession(), true);
  await Promise.all([first.request('/materials'), second.request('/materials')]);
  assert.deepEqual(new Set(seen), new Set(['Bearer ' + a.access_token, 'Bearer ' + b.access_token]));
  assert.equal(first.headers.get('cache-control'), 'private, no-store');
});

test('refreshing an expired SSR session returns HTTP-only cookies and uses the new token', async () => {
  const old = session('employee-a', true), fresh = session('employee-a');
  let refreshes = 0;
  const backend = createBackend(requestFor(old), { env, fetchImpl: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === env.SUPABASE_URL) {
      assert.equal(url.pathname, '/auth/v1/token');
      assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
      refreshes++;
      return Response.json(fresh);
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + fresh.access_token);
    return Response.json({ id: 'employee-a' });
  } });
  await backend.request('/me');
  assert.equal(refreshes, 1);
  const cookies = backend.headers.getSetCookie();
  assert.ok(cookies.some(value => value.startsWith('sb-test-project-auth-token')));
  assert.ok(cookies.every(value => /HttpOnly/i.test(value) && /Secure/i.test(value) && /SameSite=Lax/i.test(value)));
  assert.equal(backend.headers.get('cache-control'), 'private, no-cache, no-store, must-revalidate, max-age=0');
  assert.equal(backend.headers.get('expires'), '0');
  assert.equal(backend.headers.get('pragma'), 'no-cache');
});

test('an anonymous loader never substitutes a service-role or another employee token', async () => {
  const backend = createBackend(new Request('https://sales.test/materials'), {
    env, fetchImpl: async (_url, init) => {
      assert.equal(init.headers.has('authorization'), false);
      return Response.json({ detail: '로그인이 필요합니다.' }, { status: 401 });
    },
  });
  assert.equal(await backend.hasSession(), false);
  await assert.rejects(backend.request('/materials'), error => error instanceof BackendError && error.status === 401);
});

test('a valid session does not bypass Python active-employee checks', async () => {
  const backend = createBackend(requestFor(session('not-invited')), {
    env, fetchImpl: async () => Response.json({ detail: '초대된 활성 직원만 이용할 수 있습니다.' }, { status: 403 }),
  });
  await assert.rejects(backend.request('/me'), error => error instanceof BackendError && error.status === 403);
});

test('cookie-backed actions reject absent and cross-site origins', () => {
  for (const origin of [null, 'https://other.test']) {
    const request = new Request('https://sales.test/jobs', { method: 'POST', headers: origin ? { origin } : {} });
    assert.throws(() => assertSameOrigin(request), error => error instanceof Response && error.status === 403);
  }
  assert.doesNotThrow(() => assertSameOrigin(new Request('https://sales.test/jobs', { method: 'POST', headers: { origin: 'https://sales.test' } })));
});

test('nested route headers preserve cookie chunks and use the newest value per cookie', () => {
  const parentHeaders = new Headers({ 'set-cookie': 'session.0=old; HttpOnly', 'cache-control': 'public' });
  parentHeaders.append('Set-Cookie', 'session.1=chunk; HttpOnly');
  const result = routeHeaders({ parentHeaders, loaderHeaders: new Headers({ 'set-cookie': 'session.0=new; HttpOnly' }), actionHeaders: new Headers(), errorHeaders: undefined });
  assert.deepEqual(result.getSetCookie(), ['session.0=new; HttpOnly', 'session.1=chunk; HttpOnly']);
  assert.equal(result.get('cache-control'), 'private, no-store');
});

test('real Supabase credentials keep the user session even with development mode enabled', async () => {
  const employee = session('employee-a');
  const backend = createBackend(requestFor(employee), {
    env: { ...env, NODE_ENV: 'development', SALESOS_DEV_MODE: 'true', SALESOS_DEV_TOKEN: 'local-only' },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.get('authorization'), 'Bearer ' + employee.access_token);
      return Response.json({ id: 'employee-a' });
    },
  });
  await backend.request('/me');
});

test('the local development identity is limited to the SQLite configuration', async () => {
  const backend = createBackend(new Request('http://localhost:5173/chat'), {
    env: { NODE_ENV: 'development', SALESOS_DEV_MODE: 'true', SALESOS_DEV_TOKEN: 'local-only' },
  });
  assert.equal(await backend.token(), 'local-only');
});

test('public configuration loads without refreshing a broken session', async () => {
  const backend = createBackend(requestFor(session('employee-a', true)), {
    env, fetchImpl: async (input, init) => {
      assert.equal(new URL(input).origin, env.SALESOS_API_ORIGIN);
      assert.equal(new URL(input).pathname, '/api/config');
      assert.equal(init.headers.has('authorization'), false);
      return Response.json({ google_auth_enabled: true });
    },
  });
  assert.equal((await backend.request('/config')).google_auth_enabled, true);
});

test('an already-cancelled request never starts a session refresh', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request(requestFor(session('employee-a', true)), { signal: controller.signal });
  const backend = createBackend(request, { env, fetchImpl: async () => assert.fail('no request after cancellation') });
  await assert.rejects(backend.hasSession(), error => error instanceof BackendError && error.status === 503);
  assert.deepEqual(backend.headers.getSetCookie(), []);
});

for (const failure of ['503', 'timeout', 'cancel']) {
  test(`authentication ${failure} is bounded, preserves cookies, and stops SDK retry HTTP requests`, async t => {
    // Exercise the real SDK while advancing its separate internal retry timer.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const controller = new AbortController();
    const request = new Request(requestFor(session('employee-a', true)), { signal: controller.signal });
    let calls = 0;
    let transportSignal;
    const backend = createBackend(request, {
      env, authTimeoutMs: failure === 'cancel' ? 10_000 : 25,
      fetchImpl: async (_url, init) => {
        calls++;
        transportSignal = init.signal;
        assert.ok(transportSignal);
        if (failure !== 'timeout') return Response.json({ msg: 'private upstream failure' }, { status: 503 });
        return new Promise((_resolve, reject) => transportSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      },
    });
    // AbortSignal.timeout uses a native unref'ed timer, separate from SDK timers.
    const keepAlive = setInterval(() => {}, 50);
    try {
      const started = performance.now();
      const pending = backend.hasSession();
      const rejected = assert.rejects(pending, error => error instanceof BackendError && error.status === 503 && !error.message.includes('private'));
      if (failure === 'cancel') {
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
      }
      await rejected;
      assert.ok(performance.now() - started < 1000, 'must not wait for the SDK retry budget');
      assert.equal(calls, 1);
      assert.equal(transportSignal.aborted, true);
      for (let i = 0; i < 3; i++) {
        t.mock.timers.tick(31_000);
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(calls, 1, 'SDK retries must not send more HTTP requests');
      assert.deepEqual(backend.headers.getSetCookie(), [], 'an outage is not a sign-out');
    } finally { clearInterval(keepAlive); }
  });
}

test('a rejected refresh requires login and clears the expired session', async () => {
  const backend = createBackend(requestFor(session('employee-a', true)), {
    env, fetchImpl: async () => Response.json({ error_code: 'refresh_token_not_found', msg: 'private details' }, { status: 400 }),
  });
  assert.equal(await backend.hasSession(), false);
  assert.ok(backend.headers.getSetCookie().some(cookie => /Max-Age=0/.test(cookie)));
});

test('nested route headers retain all SDK refresh cache directives', () => {
  const loaderHeaders = new Headers({ 'cache-control': 'private, no-cache, no-store, must-revalidate, max-age=0', expires: '0', pragma: 'no-cache' });
  const result = routeHeaders({ parentHeaders: new Headers(), loaderHeaders, actionHeaders: new Headers(), errorHeaders: undefined });
  for (const header of ['cache-control', 'expires', 'pragma']) assert.equal(result.get(header), loaderHeaders.get(header));
});
