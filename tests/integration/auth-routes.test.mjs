/** Run after npm run build: node --test tests/integration/auth-routes.test.mjs */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, after, test } from 'node:test';

const appOrigin = 'https://sales.test';
const supabaseOrigin = 'https://salesos-fixture.supabase.co';
const apiOrigin = 'http://127.0.0.1:8765';
const serverSecret = 'fixture-service-key-must-not-reach-browser';
const storageKey = 'sb-salesos-fixture-auth-token';
const environment = {
  NODE_ENV: 'production', SALESOS_PUBLIC_URL: appOrigin, SALESOS_API_ORIGIN: apiOrigin,
  SUPABASE_URL: supabaseOrigin, SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
  SUPABASE_SERVICE_KEY: serverSecret, SALESOS_DEV_MODE: 'false',
};
const previousEnvironment = new Map();
let handle;

before(async () => {
  for (const [key, value] of Object.entries(environment)) {
    previousEnvironment.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createRequestHandler } = await import('react-router');
  const build = await import('../../build/server/index.js');
  handle = createRequestHandler(build, 'production');
});
after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function session(owner) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ sub: owner, exp: expires, aud: 'authenticated' })).toString('base64url');
  return {
    access_token: 'eyJhbGciOiJIUzI1NiJ9.' + payload + '.fixture-signature',
    refresh_token: 'fixture-refresh-' + owner,
    expires_at: expires, expires_in: 3600, token_type: 'bearer',
    user: { id: owner, aud: 'authenticated', role: 'authenticated', email: owner + '@example.test',
      app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  };
}

function cookieHeader(response, previous = '') {
  const jar = new Map(previous.split('; ').filter(Boolean).map(pair => {
    const equal = pair.indexOf('=');
    return [pair.slice(0, equal), pair.slice(equal + 1)];
  }));
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0];
    const equal = pair.indexOf('=');
    const name = pair.slice(0, equal);
    if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, pair.slice(equal + 1));
  }
  return Array.from(jar, ([name, value]) => name + '=' + value).join('; ');
}

function route(path, { method = 'GET', body, cookie, origin } = {}) {
  const headers = new Headers({ accept: 'text/html', 'user-agent': 'SALES-OS integration test' });
  if (cookie) headers.set('cookie', cookie);
  if (origin !== undefined) headers.set('origin', origin);
  return handle(new Request(appOrigin + path, { method, headers, body }));
}

function mockServices(t) {
  const state = { owner: 'employee-a', tokenFailure: false, calls: [] };
  const sessions = new Map(['employee-a', 'employee-b', 'inactive-employee'].map(owner => [owner, session(owner)]));
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get('authorization');
    const owner = Array.from(sessions).find(([, value]) => authorization === 'Bearer ' + value.access_token)?.[0];
    const call = { origin: url.origin, path: url.pathname, method: request.method, owner, authorization };
    state.calls.push(call);
    if (url.origin === supabaseOrigin && url.pathname === '/auth/v1/token') {
      assert.equal(url.searchParams.get('grant_type'), 'pkce');
      call.body = await request.json();
      if (state.tokenFailure) return Response.json({ error_code: 'bad_code_verifier', msg: 'private-provider-diagnostic' }, { status: 400 });
      return Response.json(sessions.get(state.owner));
    }
    if (url.origin === supabaseOrigin && url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (url.origin === supabaseOrigin && url.pathname === '/auth/v1/user') {
      return owner ? Response.json(sessions.get(owner).user) : Response.json({ msg: 'Not authenticated' }, { status: 401 });
    }
    if (url.origin === apiOrigin) {
      assert.equal(request.headers.has('cookie'), false, 'browser cookies must not be forwarded to Python');
      assert.notEqual(authorization, 'Bearer ' + serverSecret);
      if (url.pathname === '/api/config') return Response.json({
        supabase_url: supabaseOrigin, supabase_publishable_key: 'fixture-publishable-key',
        chatkit_domain_key: 'fixture-domain', dev_mode: false, ai_ready: true, version: 'fixture',
      });
      if (url.pathname === '/api/workspace') {
        if (!owner) return Response.json({ detail: '로그인이 필요합니다.' }, { status: 401 });
        if (owner === 'inactive-employee') return Response.json({ detail: '초대된 활성 직원만 이용할 수 있습니다.' }, { status: 403 });
        return Response.json({
          member: { id: owner, email: owner + '@example.test', display_name: owner, role: 'member' },
          items: [{ id: owner + ':drive', provider: 'google_drive', name: 'Google Drive', description: 'Drive', connected: true, enabled: true, configured: true, account: owner + '@example.test' }],
          projects: [], projects_error: '',
        });
      }
      if (url.pathname === '/api/me') {
        if (!owner) return Response.json({ detail: '로그인이 필요합니다.' }, { status: 401 });
        if (owner === 'inactive-employee') return Response.json({ detail: '초대된 활성 직원만 이용할 수 있습니다.' }, { status: 403 });
        return Response.json({ id: owner, email: owner + '@example.test', display_name: owner, role: 'member' });
      }
      if (url.pathname === '/api/connections') {
        assert.ok(owner && owner !== 'inactive-employee', 'connections require an active employee');
        return Response.json({ items: [{ id: owner + ':drive', provider: 'google_drive', name: 'Google Drive',
          description: 'Drive', connected: true, enabled: true, configured: true, account: owner + '@example.test' }] });
      }
    }
    assert.fail('Unexpected network request: ' + request.method + ' ' + url.origin + url.pathname);
  });
  return { state, sessions };
}

async function beginGoogleLogin(cookie) {
  const response = await route('/auth/sign-in', {
    method: 'POST', origin: appOrigin, cookie, body: new URLSearchParams({ provider: 'google' }),
  });
  assert.equal(response.status, 302);
  return response;
}

async function loginAs(state, owner) {
  state.owner = owner;
  const start = await beginGoogleLogin();
  const response = await route('/auth/callback?code=fixture-auth-code', { cookie: cookieHeader(start) });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/chat');
  return { start, response, cookie: cookieHeader(response, cookieHeader(start)) };
}

test('Google sign-in uses the real action and creates a protected PKCE cookie', async t => {
  const { state } = mockServices(t);
  const response = await beginGoogleLogin();
  const target = new URL(response.headers.get('location'));
  assert.equal(target.origin, supabaseOrigin);
  assert.equal(target.pathname, '/auth/v1/authorize');
  assert.equal(target.searchParams.get('provider'), 'google');
  assert.equal(target.searchParams.get('redirect_to'), appOrigin + '/auth/callback');
  assert.equal(target.searchParams.get('prompt'), 'select_account');
  assert.equal(target.searchParams.get('code_challenge_method'), 's256');
  assert.ok(target.searchParams.get('code_challenge'));
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some(cookie => cookie.includes('code-verifier=')));
  assert.ok(cookies.every(cookie => /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie)));
  assert.equal(state.calls.length, 0, 'the OAuth redirect should not read private data');
});

test('the real callback exchanges PKCE and keeps session tokens out of its response body', async t => {
  const { state, sessions } = mockServices(t);
  const { start, response, cookie } = await loginAs(state, 'employee-a');
  const exchange = state.calls.find(call => call.path === '/auth/v1/token');
  assert.equal(exchange.body.auth_code, 'fixture-auth-code');
  const challenge = createHash('sha256').update(exchange.body.code_verifier).digest('base64url');
  assert.equal(challenge, new URL(start.headers.get('location')).searchParams.get('code_challenge'));
  const sessionCookies = response.headers.getSetCookie().filter(value => !value.includes('code-verifier'));
  assert.ok(sessionCookies.length > 0);
  assert.ok(sessionCookies.every(value => /HttpOnly/i.test(value) && /Secure/i.test(value) && /SameSite=Lax/i.test(value)));
  // The SDK dual-writes per-flow slots for concurrent logins. Its legacy
  // callback (no sb_flow_id) consumes only the fixed verifier; unrelated slots
  // are intentionally retained until expiry, bounded eviction or sign-out.
  const cookieNames = cookie.split('; ').map(pair => pair.split('=', 1)[0]);
  assert.ok(!cookieNames.includes(storageKey + '-code-verifier'));
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith(storageKey + '-code-verifier=') && /Max-Age=0/i.test(value)));
  const text = await response.text();
  assert.ok(!text.includes(sessions.get('employee-a').access_token));
  assert.ok(!text.includes(serverSecret));
});

test('callbacks with a flow ID consume only their own PKCE slot across concurrent sign-ins', async t => {
  const { state } = mockServices(t);
  const first = await beginGoogleLogin();
  const second = await beginGoogleLogin(cookieHeader(first));
  const slot = response => {
    const name = response.headers.getSetCookie().map(value => value.split('=', 1)[0])
      .find(value => value.startsWith(storageKey + '-flow-') && value.endsWith('-code-verifier'));
    assert.ok(name, 'the real SDK must create a per-flow verifier slot');
    return { name, id: name.slice((storageKey + '-flow-').length, -'-code-verifier'.length) };
  };
  const firstSlot = slot(first), secondSlot = slot(second);
  assert.notEqual(firstSlot.id, secondSlot.id);
  let cookie = cookieHeader(second, cookieHeader(first));
  for (const [started, selected, authCode] of [
    [first, firstSlot, 'first-auth-code'], [second, secondSlot, 'second-auth-code'],
  ]) {
    const response = await route('/auth/callback?code=' + authCode + '&sb_flow_id=' + selected.id, { cookie });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/chat');
    const exchange = state.calls.filter(call => call.path === '/auth/v1/token').at(-1);
    assert.equal(exchange.body.auth_code, authCode);
    assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), new URL(started.headers.get('location')).searchParams.get('code_challenge'));
    cookie = cookieHeader(response, cookie);
    const names = cookie.split('; ').map(pair => pair.split('=', 1)[0]);
    assert.ok(!names.includes(selected.name), 'the selected verifier must be consumed');
    if (selected === firstSlot) {
      assert.ok(names.includes(secondSlot.name), 'a different pending login must remain usable');
      assert.ok(names.includes(storageKey + '-code-verifier'), 'the latest legacy fallback belongs to the second login');
    } else {
      assert.ok(names.every(name => !name.endsWith('-code-verifier')), 'the last explicit flow removes its index, slot and matching legacy fallback');
    }
  }
});

test('an unknown PKCE flow cannot silently borrow the latest login verifier', async t => {
  const { state } = mockServices(t);
  const start = await beginGoogleLogin();
  const original = cookieHeader(start);
  const failed = await route('/auth/callback?code=fixture-auth-code&sb_flow_id=unknown-flow-12345', { cookie: original });
  assert.equal(failed.headers.get('location'), '/chat?auth_error=expired');
  assert.equal(state.calls.some(call => call.path === '/auth/v1/token'), false);
  assert.equal(cookieHeader(failed, original), '');
});

test('a failed or cancelled callback clears the old login and returns a fixed public error', async t => {
  const { state } = mockServices(t);
  for (const path of ['/auth/callback?code=rejected-code', '/auth/callback?error=access_denied&error_description=private-provider-diagnostic']) {
    state.tokenFailure = false;
    const { cookie } = await loginAs(state, 'employee-a');
    state.tokenFailure = true;
    const failed = await route(path, { cookie });
    assert.equal(failed.status, 302);
    assert.equal(failed.headers.get('location'), path.includes('access_denied') ? '/chat?auth_error=cancelled' : '/chat?auth_error=expired');
    assert.equal(cookieHeader(failed, cookie), '', 'failed OAuth must not leave the previous identity signed in');
    assert.ok(failed.headers.getSetCookie().some(value => /Max-Age=0/i.test(value)));
    assert.ok(!(await failed.text()).includes('private-provider-diagnostic'));
  }
});

test('auth actions reject missing and cross-site origins before accessing any service', async t => {
  const { state } = mockServices(t);
  for (const path of ['/auth/sign-in', '/auth/sign-out']) {
    for (const origin of [undefined, 'https://other.test']) {
      const response = await route(path, { method: 'POST', origin, body: new URLSearchParams({ provider: 'google' }) });
      assert.equal(response.status, 403);
      assert.equal(response.headers.getSetCookie().length, 0);
      await response.text();
    }
  }
  assert.equal(state.calls.length, 0);
});

test('anonymous SSR loads no private resources and active members remain isolated between requests', async t => {
  const { state, sessions } = mockServices(t);
  const anonymous = await route('/connections');
  assert.equal(anonymous.status, 200);
  const anonymousHtml = await anonymous.text();
  assert.ok(!anonymousHtml.includes('employee-a@example.test'));
  assert.deepEqual(state.calls.map(call => call.path), ['/api/config']);
  const first = await loginAs(state, 'employee-a');
  const second = await loginAs(state, 'employee-b');
  state.calls.length = 0;
  for (const [owner, cookie] of [['employee-a', first.cookie], ['employee-b', second.cookie]]) {
    const response = await route('/connections', { cookie });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    const html = await response.text();
    assert.ok(html.includes(owner + '@example.test'));
    const other = owner === 'employee-a' ? 'employee-b' : 'employee-a';
    assert.ok(!html.includes(other + '@example.test'));
    assert.ok(!html.includes(sessions.get(owner).access_token));
    assert.ok(!html.includes(sessions.get(owner).refresh_token));
    assert.ok(!html.includes(serverSecret));
  }
  assert.deepEqual(state.calls.filter(call => call.path === '/api/workspace').map(call => call.owner), ['employee-a', 'employee-b']);
  assert.deepEqual(state.calls.map(call => call.path), ['/api/config', '/api/workspace', '/api/config', '/api/workspace'], 'each authenticated page uses one workspace bootstrap instead of repeated identity requests');
  const inactive = await loginAs(state, 'inactive-employee');
  state.calls.length = 0;
  const rejected = await route('/connections', { cookie: inactive.cookie });
  const html = await rejected.text();
  assert.ok(html.includes('초대된 활성 직원만 이용할 수 있습니다.'));
  assert.ok(!html.includes('inactive-employee@example.test'));
  assert.equal(state.calls.some(call => call.path === '/api/connections'), false);
});

test('production .data login accepts the exact public origin behind the container proxy', async t => {
  const { state } = mockServices(t);
  const previous = process.env.SALESOS_PUBLIC_URL;
  process.env.SALESOS_PUBLIC_URL = 'https://sales.example';
  try {
    const response = await handle(new Request('http://127.0.0.1:80/auth/sign-in.data', {
      method: 'POST', headers: { origin: process.env.SALESOS_PUBLIC_URL },
      body: new URLSearchParams({ provider: 'google', return_to: '/projects' }),
    }));
    assert.equal(response.status, 202);
    assert.ok(response.headers.getSetCookie().some(value => value.includes('code-verifier=')));
    const text = await response.text();
    assert.ok(text.includes('/auth/v1/authorize'));
    assert.ok(text.includes(encodeURIComponent(process.env.SALESOS_PUBLIC_URL + '/auth/callback')));
    assert.equal(state.calls.length, 0);
  } finally { process.env.SALESOS_PUBLIC_URL = previous; }
});

test('container .data actions still reject unrelated origins without creating login cookies', async t => {
  const { state } = mockServices(t);
  t.mock.method(console, 'error', () => {});
  const response = await handle(new Request('http://127.0.0.1:80/auth/sign-in.data', {
    method: 'POST', headers: { origin: 'https://attacker.vercel.app' },
    body: new URLSearchParams({ provider: 'google' }),
  }));
  assert.equal(response.status, 400);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.equal(state.calls.length, 0);
  await response.text();
});
