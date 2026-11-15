import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Resolve the app's existing TypeScript aliases without starting Vite or a server.
const appRoot = new URL('../../app/', import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('~/')) return nextResolve(new URL(specifier.slice(2) + '.ts', appRoot).href, context);
  if (specifier.startsWith('.') && context.parentURL?.startsWith(appRoot.href)) {
    const file = new URL(specifier + '.ts', context.parentURL);
    if (existsSync(file)) return nextResolve(file.href, context);
  }
  return nextResolve(specifier, context);
} });
const { action: manageConnection } = await import('../../app/features/connections/pages/connection-action.ts');

function request(path, fields, origin = 'https://sales.example.test') {
  return new Request('https://sales.example.test' + path, fields ? {
    method: 'POST', headers: { origin }, body: new URLSearchParams(fields),
  } : undefined);
}
function connection(fields, origin) {
  return manageConnection({ request: request('/connections/manage', { member_id: 'employee-a', provider: 'gmail', ...fields }, origin), params: {}, context: {} });
}
async function withBackendFetch(fetchImpl, run) {
  const values = { NODE_ENV: 'test', SALESOS_DEV_MODE: 'true', SALESOS_DEV_TOKEN: 'test-token', SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SERVICE_KEY: '', SALESOS_API_ORIGIN: 'http://127.0.0.1:8000' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await run(); }
  finally { globalThis.fetch = previousFetch; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
test('account mutations target only the selected account and carry the employee guard', async () => {
  const calls = [];
  await withBackendFetch(async (url, init) => {
    calls.push([url.pathname, init.method, init.body]);
    assert.equal(init.headers.get('X-SalesOS-Member'), 'employee-a');
    assert.equal(init.headers.get('authorization'), 'Bearer test-token');
    return Response.json({ ok: true });
  }, async () => {
    assert.equal((await connection({ intent: 'toggle', connection_id: 'account-a', enabled: 'false' })).data.error, '');
    assert.equal((await connection({ intent: 'disconnect', connection_id: 'account-b' })).data.error, '');
    assert.equal((await connection({ provider: 'notion', intent: 'toggle', connection_id: 'employee-a:notion', enabled: 'true' })).data.error, '');
  });
  assert.deepEqual(calls, [
    ['/api/connections/gmail/accounts/account-a', 'PATCH', '{"enabled":false}'],
    ['/api/connections/gmail/accounts/account-b', 'DELETE', undefined],
    ['/api/connections/notion/accounts/employee-a%3Anotion', 'PATCH', '{"enabled":true}'],
  ]);
});

test('missing account, malformed account and invalid enabled value cannot mutate a whole provider', async () => {
  await withBackendFetch(async () => { assert.fail('No API call is allowed'); }, async () => {
    for (const fields of [
      { intent: 'disconnect' },
      { intent: 'toggle', connection_id: '../other', enabled: 'true' },
      { intent: 'toggle', connection_id: 'account-a', enabled: 'invalid' },
      { intent: 'connect', member_id: '' },
    ]) assert.ok((await connection(fields)).data.error);
  });
});

test('adding an account and reconnecting an existing account send distinct OAuth start bodies', async () => {
  const bodies = [];
  await withBackendFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test' });
  }, async () => {
    for (const fields of [{ intent: 'connect' }, { intent: 'connect', connection_id: 'account-a' }]) {
      const result = await connection(fields);
      assert.equal(result.status, 302);
      assert.equal(new URL(result.headers.get('location')).hostname, 'accounts.google.com');
    }
  });
  assert.deepEqual(bodies, [{}, { connection_id: 'account-a' }]);
});

test('connection actions reject cross-site requests and untrusted OAuth redirects', async () => {
  await assert.rejects(connection({ intent: 'connect' }, 'https://other.example.test'), error => error instanceof Response && error.status === 403);
  await withBackendFetch(async () => Response.json({ url: 'https://accounts.google.com@attacker.example/authorize' }), async () => {
    const result = await connection({ intent: 'connect' });
    assert.equal(result.init.status, 502);
    assert.ok(result.data.error);
  });
});

test('backend ownership denial remains an error instead of a successful account mutation', async () => {
  await withBackendFetch(async () => Response.json({ detail: '현재 로그인 계정이 변경되었습니다.' }, { status: 403 }), async () => {
    const result = await connection({ intent: 'disconnect', connection_id: 'other-employee-account' });
    assert.equal(result.init.status, 403);
    assert.equal(result.data.message, '');
  });
});
