import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatReadCache } from '../../app/features/chat/components/chat-read-cache.ts';
const request = (type = 'threads.get_by_id', params = { thread_id: 'thr_one' }) => ({ method: 'POST', body: JSON.stringify({ type, params }) });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('revisiting a thread and its pages reuses read responses', async () => {
  let calls = 0;
  const cache = createChatReadCache(async () => json({ load: ++calls }));
  for (const type of ['threads.get_by_id', 'items.list', 'threads.list']) {
    const first = await (await cache.fetch('/api/chatkit', request(type))).json();
    const second = await (await cache.fetch('/api/chatkit', request(type))).json();
    assert.deepEqual(second, first);
  }
  assert.equal(calls, 3);
});

test('different accounts and project panels never share cached thread data', async () => {
  const a = createChatReadCache(async () => json({ owner: 'a' }));
  const b = createChatReadCache(async () => json({ owner: 'b' }));
  assert.equal((await (await a.fetch('/api/chatkit', request())).json()).owner, 'a');
  assert.equal((await (await b.fetch('/api/chatkit', request())).json()).owner, 'b');
});

test('messages and other mutations clear reads and are never cached', async () => {
  let reads = 0, writes = 0;
  const cache = createChatReadCache(async (url, init) => JSON.parse(init.body).type === 'threads.get_by_id' ? json({ read: ++reads }) : json({ write: ++writes }));
  await cache.fetch('/api/chatkit', request());
  await cache.fetch('/api/chatkit', request('threads.add_user_message'));
  await cache.fetch('/api/chatkit', request('threads.add_user_message'));
  assert.equal((await (await cache.fetch('/api/chatkit', request())).json()).read, 2);
  assert.equal(writes, 2);
  cache.clear(); // response-end / session change
  await cache.fetch('/api/chatkit', request());
  assert.equal(reads, 3);
});

test('old in-flight reads cannot restore a cache after invalidation', async () => {
  let finish, calls = 0;
  const cache = createChatReadCache(async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : json({ fresh: true }));
  const old = cache.fetch('/api/chatkit', request());
  cache.clear();
  finish(json({ fresh: false }));
  await old;
  assert.equal((await (await cache.fetch('/api/chatkit', request())).json()).fresh, true);
  assert.equal(calls, 2);
});

test('expired data, failures and aborted requests do not reuse stale responses', async () => {
  let calls = 0;
  const expired = createChatReadCache(async () => json({ calls: ++calls }), 0);
  await expired.fetch('/api/chatkit', request()); await expired.fetch('/api/chatkit', request());
  assert.equal(calls, 2);
  const failed = createChatReadCache(async () => json({ error: 'denied' }, ++calls === 3 ? 401 : 200));
  assert.equal((await failed.fetch('/api/chatkit', request())).status, 401);
  assert.equal((await failed.fetch('/api/chatkit', request())).status, 200);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(failed.fetch('/api/chatkit', { ...request(), signal: abort.signal }), { name: 'AbortError' });
  assert.equal(calls, 4);
});

test('streaming responses and unrelated uploads pass through untouched', async () => {
  let calls = 0;
  const cache = createChatReadCache(async () => { calls++; return new Response('data: event\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); });
  assert.equal(await (await cache.fetch('/api/chatkit', request())).text(), 'data: event\n\n');
  await cache.fetch('/api/chatkit', request());
  await cache.fetch('/api/attachments/upload', { method: 'POST', body: 'file' });
  assert.equal(calls, 3);
});
