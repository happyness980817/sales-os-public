import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRoot, executeJob, MAX_FILE_BYTES } from '../src/files';
import { normalizeServerUrl } from '../src/client';

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'salesos-connect-test-'));
  try { await run(directory); } finally {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    assert.ok(relative.startsWith('salesos-connect-test-') && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  }
}
test('selected folder listing and recursive filename search return relative paths, not arbitrary file bodies', async () => fixture(async directory => {
  const allowed = path.join(directory, 'work'); await mkdir(path.join(allowed, '고객'), { recursive: true });
  await writeFile(path.join(allowed, '고객', 'A사-견적.txt'), '읽기 전용 자료');
  await writeFile(path.join(allowed, '.env'), 'NEVER_SEND=fixture');
  await writeFile(path.join(allowed, 'run.exe'), 'not executable');
  const root = await createRoot(allowed);
  const result = await executeJob([root], { id: 'list', root_id: root.id, operation: 'list' });
  assert.equal(result.ok, true); assert.equal(result.files?.length, 1); assert.equal(result.files?.[0].relative_path, '고객');
  const search = await executeJob([root], { id: 'search', root_id: root.id, operation: 'search', query: 'A사' });
  assert.deepEqual(search.files?.map(file => file.relative_path), ['고객/A사-견적.txt']);
  assert.equal(search.content_base64, undefined);
}));
test('read returns exact bytes and content hash without modifying the original', async () => fixture(async directory => {
  const root = await createRoot(directory); const file = path.join(directory, 'memo.txt'); await writeFile(file, '미팅 준비\nA사');
  const before = await readFile(file); const result = await executeJob([root], { id: 'read', root_id: root.id, operation: 'read', path: 'memo.txt' });
  assert.equal(result.ok, true, result.error ?? 'read must succeed'); assert.equal(result.filename, 'memo.txt'); assert.equal(result.relative_path, 'memo.txt');
  assert.equal(Buffer.from(result.content_base64!, 'base64').toString(), before.toString());
  assert.match(result.sha256!, /^[a-f0-9]{64}$/); assert.deepEqual(await readFile(file), before);
}));
test('traversal, absolute paths, same-prefix sibling, alternate data streams and hidden names are blocked', async () => fixture(async directory => {
  const allowed = path.join(directory, 'work'), sibling = path.join(directory, 'work-private');
  await mkdir(allowed); await mkdir(sibling); await writeFile(path.join(sibling, 'secret.txt'), 'fixture only');
  await writeFile(path.join(allowed, '.hidden.txt'), 'fixture only');
  const root = await createRoot(allowed);
  for (const bad of ['../work-private/secret.txt', '..\\work-private\\secret.txt', path.join(sibling, 'secret.txt'), 'C:\\Windows\\file.txt', 'note.txt:stream', '.hidden.txt', 'folder./x.txt']) {
    const result = await executeJob([root], { id: 'bad', root_id: root.id, operation: 'read', path: bad });
    assert.equal(result.ok, false, bad); assert.equal(result.content_base64, undefined, bad);
    assert.equal(result.error?.includes(directory), false);
  }
}));
test('junction or directory symlink cannot expose files outside the allowed root', async () => fixture(async directory => {
  const allowed = path.join(directory, 'work'), other = path.join(directory, 'outside');
  await mkdir(allowed); await mkdir(other); await writeFile(path.join(other, 'secret.txt'), 'fixture only');
  await symlink(other, path.join(allowed, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  const root = await createRoot(allowed);
  const direct = await executeJob([root], { id: 'link', root_id: root.id, operation: 'read', path: 'shortcut/secret.txt' });
  assert.equal(direct.ok, false); assert.match(direct.error!, /LINK_BLOCKED/);
  const search = await executeJob([root], { id: 'search', root_id: root.id, operation: 'search', query: 'secret' });
  assert.equal(search.files?.length, 0);
}));
test('unknown or disabled roots, oversize, missing and executable files are explicit failures', async () => fixture(async directory => {
  const root = await createRoot(directory);
  await writeFile(path.join(directory, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1));
  await writeFile(path.join(directory, 'script.ps1'), 'fixture only');
  const unknown = await executeJob([], { id: 'unknown', root_id: root.id, operation: 'read', path: 'big.txt' }); assert.match(unknown.error!, /ROOT_DISABLED/);
  const disabled = await executeJob([{ ...root, enabled: false }], { id: 'disabled', root_id: root.id, operation: 'list' }); assert.equal(disabled.ok, false);
  const big = await executeJob([root], { id: 'big', root_id: root.id, operation: 'read', path: 'big.txt' }); assert.match(big.error!, /FILE_TOO_LARGE/);
  const missing = await executeJob([root], { id: 'missing', root_id: root.id, operation: 'read', path: 'missing.txt' }); assert.match(missing.error!, /ENOENT/);
  const unsupported = await executeJob([root], { id: 'type', root_id: root.id, operation: 'read', path: 'script.ps1' }); assert.match(unsupported.error!, /UNSUPPORTED_FORMAT/);
  const operation = await executeJob([root], { id: 'op', root_id: root.id, operation: 'execute' as any }); assert.match(operation.error!, /UNSUPPORTED_OPERATION/);
}));
test('search limits and cancellation are reported, not presented as complete results', async () => fixture(async directory => {
  const root = await createRoot(directory);
  for (let i = 0; i < 6; i++) await writeFile(path.join(directory, `item-${i}.txt`), 'fixture');
  const result = await executeJob([root], { id: 'bounded', root_id: root.id, operation: 'search', limit: 2 });
  assert.equal(result.files?.length, 2); assert.equal(result.truncated, true);
  const controller = new AbortController(); controller.abort();
  const cancelled = await executeJob([root], { id: 'cancel', root_id: root.id, operation: 'read', path: 'item-0.txt' }, controller.signal);
  assert.match(cancelled.error!, /CANCELLED/); assert.equal(cancelled.content_base64, undefined);
}));
test('server connection allows HTTPS or loopback HTTP only and rejects embedded credentials', () => {
  assert.equal(normalizeServerUrl('https://sales.example.com/'), 'https://sales.example.com');
  assert.equal(normalizeServerUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
  for (const bad of ['http://sales.example.com', 'https://user:password@example.com', 'https://example.com/api', 'file:///c:/test', 'https://example.com/?token=x']) assert.throws(() => normalizeServerUrl(bad));
});

test('deployment cap rejects oversized reads before producing bytes and legacy calls keep 10MiB', async () => fixture(async directory => {
  const root = await createRoot(directory);
  const deployedLimit = 3 * 1024 * 1024;
  await writeFile(path.join(directory, 'deployment.txt'), Buffer.alloc(deployedLimit + 1, 'a'));
  const job = { id: 'deployment', root_id: root.id, operation: 'read' as const, path: 'deployment.txt' };
  const capped = await executeJob([root], { ...job, max_file_bytes: deployedLimit });
  assert.equal(capped.ok, false); assert.match(capped.error!, /FILE_TOO_LARGE/);
  assert.equal(capped.content_base64, undefined);
  assert.equal((await executeJob([root], job, undefined, deployedLimit)).ok, false);
  const legacy = await executeJob([root], job);
  assert.equal(legacy.ok, true); assert.equal(legacy.size, deployedLimit + 1);
}));
