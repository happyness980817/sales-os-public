import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Connector } from '../src/connector';
import { createRoot } from '../src/files';
import { initialState } from '../src/storage';
import { request } from '../src/client';
import type { ConnectorState } from '../src/types';

test('device enrollment, scoped roots, claim and result perform a real local HTTP round trip', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'salesos-bridge-test-'));
  await writeFile(path.join(directory, 'brief.txt'), 'A사 미팅 자료');
  const root = await createRoot(directory);
  let resolveResult!: (value: any) => void;
  const completed = new Promise<any>(resolve => { resolveResult = resolve; });
  const received: Array<{ url: string; body: any; token?: string }> = [];
  let claimed = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    received.push({ url: req.url!, body, token: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/device/enroll') { res.end(JSON.stringify({ device_id: 'test-device', device_token: 'test-only-token' })); return; }
    if (req.headers.authorization !== 'Bearer test-only-token') { res.statusCode = 401; res.end('{}'); return; }
    if (req.url === '/api/device/jobs/claim') {
      const job = claimed ? null : { id: 'test-job', operation: 'read', root_id: root.id, path: 'brief.txt' }; claimed = true; res.end(JSON.stringify({ job })); return;
    }
    if (req.url === '/api/device/jobs/test-job/result') resolveResult(body);
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let saved: ConnectorState = initialState();
  const connector = new Connector({ read: () => structuredClone(saved), write: state => { saved = structuredClone(state); } }, () => {}, 'test');
  connector.stop();
  try {
    await connector.enroll({ serverUrl: `http://127.0.0.1:${address.port}`, code: 'TESTCODE', name: '시험 PC' });
    await connector.addRoot(root); connector.start();
    const result = await Promise.race([completed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Device result timed out')), 10_000); timer.unref(); })]);
    assert.equal(result.ok, true); assert.equal(Buffer.from(result.content_base64, 'base64').toString(), 'A사 미팅 자료');
    const metadata = received.find(item => item.url === '/api/device/roots')!;
    assert.deepEqual(metadata.body, { roots: [{ id: root.id, name: root.name, enabled: true }] });
    assert.equal(JSON.stringify(received).includes(directory.replaceAll('\\', '\\\\')), false);
    assert.equal(connector.publicState().connected, true);
    assert.equal(JSON.stringify(connector.publicState()).includes('test-only-token'), false);
  } finally {
    connector.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory)); assert.ok(relative.startsWith('salesos-bridge-test-') && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
test('device token is never forwarded through a redirect', async () => {
  let destinationSeen = false;
  const server = createServer((req, res) => {
    if (req.url === '/destination') destinationSeen = true;
    res.statusCode = 302; res.setHeader('Location', '/destination'); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await assert.rejects(request(`http://127.0.0.1:${address.port}`, '/redirect', 'POST', {}, 'test-only-token')); assert.equal(destinationSeen, false); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const mode of ['claim-cap', 'pending-cap', 'gateway-413'] as const) {
  test(`deployment limit is applied through polling and queued uploads: ${mode}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'salesos-bridge-test-'));
    const cap = 3 * 1024 * 1024;
    const bytes = Buffer.alloc(cap + 1, 'a');
    await writeFile(path.join(directory, 'large.txt'), bytes);
    const root = await createRoot(directory);
    let completed!: (body: any) => void;
    const done = new Promise<any>(resolve => { completed = resolve; });
    const uploaded: any[] = [];
    let claimed = false;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/device/enroll') { res.end(JSON.stringify({ device_id: 'deployment-device', device_token: 'test-token', max_file_bytes: 10 * 1024 * 1024 })); return; }
      if (req.headers.authorization !== 'Bearer test-token') { res.statusCode = 401; res.end('{}'); return; }
      if (req.url === '/api/device/heartbeat') { res.end(JSON.stringify({ max_file_bytes: mode === 'pending-cap' || uploaded.length ? cap : 10 * 1024 * 1024 })); return; }
      if (req.url === '/api/device/jobs/claim') {
        const job = claimed || mode === 'pending-cap' ? null : { id: 'deployment-job', operation: 'read', root_id: root.id, path: 'large.txt' };
        claimed = true;
        res.end(JSON.stringify({ job, ...(mode === 'claim-cap' ? { max_file_bytes: cap } : {}) })); return;
      }
      if (req.url === '/api/device/jobs/deployment-job/result') {
        uploaded.push(body);
        if (mode === 'gateway-413' && uploaded.length === 1) { res.statusCode = 413; res.end(JSON.stringify({ detail: 'Payload too large' })); return; }
        completed(body);
      }
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    let saved: ConnectorState = initialState();
    const connector = new Connector({ read: () => structuredClone(saved), write: value => { saved = structuredClone(value); } }, () => {
      if (mode === 'gateway-413' && connector.publicState().message === '서버의 파일 전송 한도를 확인하고 있습니다.') {
        const timer = setTimeout(() => connector.retry(), 0); timer.unref();
      }
    }, 'test');
    connector.stop();
    try {
      await connector.enroll({ serverUrl: `http://127.0.0.1:${address.port}`, code: 'TESTCODE', name: 'Deployment PC' });
      assert.equal(connector.publicState().maxFileBytes, 10 * 1024 * 1024);
      await connector.addRoot(root);
      if (mode === 'pending-cap') {
        connector.state.pendingResult = { job_id: 'deployment-job', root_id: root.id, result: {
          ok: true, relative_path: 'large.txt', filename: 'large.txt', size: bytes.length, content_base64: bytes.toString('base64'),
        } };
      }
      connector.start();
      const result = await Promise.race([done, new Promise<any>((_, reject) => { const timer = setTimeout(() => reject(new Error('limit test timeout')), 10_000); timer.unref(); })]);
      assert.equal(result.ok, false); assert.match(result.error, /FILE_TOO_LARGE/);
      assert.equal(result.content_base64, undefined);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
      assert.equal(connector.publicState().maxFileBytes, cap);
      assert.equal(saved.pendingResult?.result.content_base64, undefined);
      if (mode === 'gateway-413') {
        assert.equal(uploaded.length, 2);
        assert.equal(typeof uploaded[0].content_base64, 'string');
      } else assert.equal(uploaded.length, 1);
    } finally {
      connector.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory)); assert.ok(relative.startsWith('salesos-bridge-test-') && !relative.includes(path.sep));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
