import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyApiRequest } from '../../app/common/server/api-proxy.server.ts';

test('forwards raw webhook bytes and explicit credentials only', async () => {
  const raw = '{ "events": [] }';
  const result = await proxyApiRequest(new Request('https://sales.example/api/internal/line/events?source=line', {
    method: 'POST', body: raw,
    headers: { authorization: 'Bearer inbound-token', 'x-line-signature': 'test-signature', 'content-type': 'application/json', cookie: 'private=value', 'x-forwarded-host': 'attacker.example' },
  }), { fetchImpl: async (url, init) => {
    assert.equal(url.href, 'http://127.0.0.1:8000/api/internal/line/events?source=line');
    assert.equal(init.headers.get('authorization'), 'Bearer inbound-token');
    assert.equal(init.headers.get('x-line-signature'), 'test-signature');
    assert.equal(init.headers.has('cookie'), false);
    assert.equal(init.headers.has('x-forwarded-host'), false);
    assert.equal(await new Response(init.body).text(), raw);
    assert.equal(init.redirect, 'manual');
    return Response.json({ accepted: true });
  } });
  assert.equal(result.status, 200);
});

test('preserves OAuth redirects for the browser instead of following them', async () => {
  const response = await proxyApiRequest(new Request('http://localhost:5173/api/connections/google/callback?code=temporary'), {
    fetchImpl: async () => new Response(null, { status: 303, headers: { location: '/connections?connected=1' } }),
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/connections?connected=1');
});

for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']) {
  test(`streams ChatKit events using ${model} without waiting for the entire agent response`, async () => {
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode('data: first\n\n')); } });
    const result = await proxyApiRequest(new Request('http://localhost:5173/api/chatkit', { method: 'POST', body: '{}', headers: { 'X-SalesOS-Model': model, 'X-SalesOS-Project': 'prj_test' } }), {
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.get('x-salesos-model'), model);
        assert.equal(init.headers.get('x-salesos-project'), 'prj_test');
        return new Response(body, { headers: { 'content-type': 'text/event-stream', 'content-length': '999', 'content-encoding': 'gzip' } });
      },
    });
    assert.equal(result.headers.get('x-accel-buffering'), 'no');
    assert.equal(result.headers.has('content-length'), false);
    assert.equal(result.headers.has('content-encoding'), false);
    const reader = result.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
    controller.enqueue(new TextEncoder().encode('data: last\n\n'));
    controller.close();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n');
    assert.equal((await reader.read()).done, true);
  });
}

test('does not reveal internal errors, credentials, or infrastructure details', async () => {
  const response = await proxyApiRequest(new Request('http://localhost:5173/api/config'), {
    fetchImpl: async () => { throw new Error('internal-host secret=never-show-this'); },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('never-show-this'), false);
});

test('rejects non-API paths and oversized declared bodies before forwarding', async () => {
  const fetchImpl = async () => { assert.fail('must not contact the service'); };
  assert.equal((await proxyApiRequest(new Request('http://localhost:5173/private'), { fetchImpl })).status, 404);
  assert.equal((await proxyApiRequest(new Request('http://localhost:5173/api/attachments/upload', { method: 'POST', headers: { 'content-length': '20000000' } }), { fetchImpl })).status, 413);
});


test('logs only allowlisted fetch diagnostics without secrets or automatic POST retry', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const secret = 'must-not-appear-in-diagnostics';
  const error = new TypeError('upstream secret=' + secret, { cause: { code: 'ECONNREFUSED', address: secret, token: secret } });
  error.stack = secret;
  let calls = 0;
  const response = await proxyApiRequest(new Request('https://sales.example/api/internal/line/events?secret=' + secret, {
    method: 'POST', body: secret, headers: { authorization: 'Bearer ' + secret, 'x-line-signature': secret },
  }), { fetchImpl: async () => { calls++; throw error; } });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(logs.length, 1);
  const line = logs[0][0];
  const diagnostic = JSON.parse(line.slice(line.indexOf('{')));
  assert.deepEqual(diagnostic, {
    reason: 'upstream_fetch_failed', error_name: 'TypeError', error_code: 'ECONNREFUSED',
    request_aborted: false, timeout_aborted: false,
  });
  assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.equal(JSON.stringify(logs).includes('https://'), false);
  assert.equal((await response.text()).includes('ECONNREFUSED'), false);
});

test('unknown exception names and codes cannot inject arbitrary strings into logs', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  const secret = 'private-name-and-code';
  const response = await proxyApiRequest(new Request('https://sales.example/api/config'), {
    fetchImpl: async () => { throw { name: secret, message: secret, cause: { code: secret } }; },
  });
  assert.equal(response.status, 503);
  assert.equal(logs.join('').includes(secret), false);
  const diagnostic = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.equal(diagnostic.error_name, 'UnknownError');
  assert.equal(diagnostic.error_code, 'UNKNOWN');
});

test('records incoming request cancellation separately from upstream connection failures', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  const controller = new AbortController();
  const response = await proxyApiRequest(new Request('https://sales.example/api/health', { signal: controller.signal }), {
    fetchImpl: async (_url, init) => {
      controller.abort('private caller abort reason');
      assert.equal(init.signal.aborted, true);
      throw new DOMException('private abort diagnostic', 'AbortError');
    },
  });
  assert.equal(response.status, 503);
  const diagnostic = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.deepEqual(diagnostic, {
    reason: 'request_aborted', error_name: 'AbortError', error_code: 'UNKNOWN',
    request_aborted: true, timeout_aborted: false,
  });
  assert.equal(logs.join('').includes('private'), false);
});


test('records the proxy deadline separately and preserves its public 504 response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  const pending = proxyApiRequest(new Request('https://sales.example/api/health'), {
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('private timeout diagnostic', 'AbortError')), { once: true });
    }),
  });
  t.mock.timers.tick(120_000);
  const response = await pending;
  assert.equal(response.status, 504);
  const diagnostic = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.deepEqual(diagnostic, {
    reason: 'proxy_timeout', error_name: 'AbortError', error_code: 'UNKNOWN',
    request_aborted: false, timeout_aborted: true,
  });
  assert.equal(logs.join('').includes('private'), false);
});


test('forwards the visible employee guard alongside the verified bearer', async () => {
  const response = await proxyApiRequest(new Request('https://sales.example/api/chatkit', {
    method: 'POST', body: '{}', headers: { authorization: 'Bearer employee-b', 'x-salesos-member': 'employee-a' },
  }), { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.get('authorization'), 'Bearer employee-b');
    assert.equal(init.headers.get('x-salesos-member'), 'employee-a');
    return Response.json({ detail: 'Account changed' }, { status: 409 });
  } });
  assert.equal(response.status, 409);
});


test('project scope reaches ChatKit without forwarding browser cookies', async () => {
  await proxyApiRequest(new Request('https://sales.test/api/chatkit', {
    method: 'POST', body: '{}', headers: { 'X-SalesOS-Project': 'prj_example', 'X-SalesOS-Member': 'employee-a', cookie: 'private=secret' },
  }), { fetchImpl: async (_url, init) => {
    assert.equal(init.headers.get('x-salesos-project'), 'prj_example');
    assert.equal(init.headers.get('x-salesos-member'), 'employee-a');
    assert.equal(init.headers.has('cookie'), false);
    return Response.json({});
  }});
});
