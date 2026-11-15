import { createHash, randomUUID } from 'node:crypto';
import { lstat, opendir, realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceJob, FileEntry, JobResult, LocalRoot } from './types';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export function fileByteLimit(value: unknown, fallback = MAX_FILE_BYTES): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_FILE_BYTES) : fallback;
}
export function limitResult(result: JobResult, limit: number): JobResult {
  const maximum = fileByteLimit(limit);
  if (typeof result.content_base64 === 'string' && Buffer.byteLength(result.content_base64, 'base64') > maximum) {
    return { ok: false, error: `FILE_TOO_LARGE: 서버의 PC 파일 한도는 ${maximum / (1024 * 1024)}MB입니다.` };
  }
  return result;
}
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 16;
const MAX_RESULTS = 500;
const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
const BLOCKED_DIRECTORIES = new Set(['node_modules', '$recycle.bin', 'system volume information']);

export class FileAccessError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'FileAccessError'; }
}
function comparePath(value: string) { return process.platform === 'win32' ? value.toLowerCase() : value; }
export function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(comparePath(root), comparePath(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function fail(code: string, message: string): never { throw new FileAccessError(code, message); }
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) fail('CANCELLED', '파일 조회가 중지되었습니다.'); }
function safeSegments(relative: string, allowRoot = false): string[] {
  if (typeof relative !== 'string' || relative.length > 2048 || relative.includes('\0')) fail('INVALID_PATH', '파일 위치가 올바르지 않습니다.');
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes(':')) fail('OUTSIDE_ROOT', '지정한 폴더 안의 파일만 읽을 수 있습니다.');
  if (!relative && allowRoot) return [];
  const parts = relative.replaceAll('\\', '/').split('/');
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || part.startsWith('.'))) fail('INVALID_PATH', '숨김 경로나 상위 폴더에는 접근할 수 없습니다.');
  return parts;
}
export async function createRoot(folder: string): Promise<LocalRoot> {
  const canonical = await realpath(folder);
  if (!(await stat(canonical)).isDirectory()) fail('NOT_DIRECTORY', '폴더를 선택해 주세요.');
  if (canonical === path.parse(canonical).root) fail('DRIVE_ROOT', '드라이브 전체 대신 업무 폴더를 선택해 주세요.');
  return { id: randomUUID(), name: path.basename(canonical), path: canonical, enabled: true };
}
async function resolveAllowed(root: LocalRoot, relative: string, allowRoot = false): Promise<string> {
  if (!root.enabled) fail('ROOT_DISABLED', '이 폴더의 연결이 해제되었습니다.');
  const parts = safeSegments(relative, allowRoot);
  const currentRoot = await realpath(root.path);
  if (comparePath(currentRoot) !== comparePath(root.path)) fail('ROOT_CHANGED', '폴더 위치가 변경되었습니다. 다시 연결해 주세요.');
  let candidate = root.path;
  for (const part of parts) {
    candidate = path.join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) fail('LINK_BLOCKED', '바로가기·심볼릭 링크·junction은 읽지 않습니다.');
  }
  const canonical = await realpath(candidate);
  if (!isContained(root.path, canonical)) fail('OUTSIDE_ROOT', '지정한 폴더 안의 파일만 읽을 수 있습니다.');
  return canonical;
}
function visibleName(name: string) { return !name.startsWith('.') && !BLOCKED_DIRECTORIES.has(name.toLowerCase()) && !/[ .]$/.test(name); }
function publicRelative(root: string, file: string) { return path.relative(root, file).split(path.sep).join('/'); }
function sameIdentity(a: { ino: number; dev: number }, b: { ino: number; dev: number }) {
  // Windows virtualized paths may report dev=0 while fstat returns the real volume id.
  return a.ino === b.ino && (a.dev === 0 || b.dev === 0 || a.dev === b.dev);
}

export async function listFiles(root: LocalRoot, job: DeviceJob, signal?: AbortSignal): Promise<JobResult> {
  throwIfAborted(signal);
  const directory = await resolveAllowed(root, job.path ?? '', true);
  if (!(await stat(directory)).isDirectory()) fail('NOT_DIRECTORY', '목록을 읽을 폴더가 아닙니다.');
  const query = (job.query ?? '').trim().toLocaleLowerCase();
  if (query.length > 200) fail('INVALID_QUERY', '검색어를 200자 이내로 입력해 주세요.');
  const limit = Math.max(1, Math.min(Number.isInteger(job.limit) ? job.limit! : 100, MAX_RESULTS));
  const recursive = job.operation === 'search';
  const queue = [{ directory, depth: 0 }];
  const files: FileEntry[] = [];
  let scanned = 0, truncated = false;
  while (queue.length && scanned < MAX_ENTRIES && files.length < limit) {
    const next = queue.shift()!;
    throwIfAborted(signal);
    // Revalidate each directory before opening it; links are never followed.
    const allowed = await resolveAllowed(root, publicRelative(root.path, next.directory), true);
    let handle;
    try { handle = await opendir(allowed); }
    catch { fail('DIRECTORY_UNREADABLE', '일부 폴더를 읽지 못했습니다. PC에서 접근 권한을 확인해 주세요.'); }
    for await (const entry of handle) {
      throwIfAborted(signal);
      scanned += 1;
      if (scanned > MAX_ENTRIES || files.length >= limit) { truncated = true; break; }
      if (!visibleName(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(next.directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive && next.depth < MAX_DEPTH) queue.push({ directory: full, depth: next.depth + 1 });
        else if (recursive) truncated = true;
        if (!recursive) files.push({ name: entry.name, relative_path: publicRelative(root.path, full), is_directory: true });
      } else if (entry.isFile() && MIME[path.extname(entry.name).toLowerCase()] && (!query || entry.name.toLocaleLowerCase().includes(query))) {
        const canonical = await resolveAllowed(root, publicRelative(root.path, full));
        const metadata = await stat(canonical);
        if (!metadata.isFile()) continue;
        files.push({ name: entry.name, relative_path: publicRelative(root.path, canonical), is_directory: false, size: metadata.size, mtime: metadata.mtime.toISOString() });
      }
    }
  }
  if (queue.length || scanned >= MAX_ENTRIES) truncated = true;
  files.sort((a, b) => Number(b.is_directory) - Number(a.is_directory) || a.name.localeCompare(b.name, 'ko'));
  return { ok: true, files, scanned, truncated };
}

export async function readLocalFile(root: LocalRoot, relative: string, signal?: AbortSignal, maxFileBytes = MAX_FILE_BYTES): Promise<JobResult> {
  throwIfAborted(signal);
  const file = await resolveAllowed(root, relative);
  const extension = path.extname(file).toLowerCase();
  if (!MIME[extension]) fail('UNSUPPORTED_FORMAT', 'TXT·MD·CSV·XLSX·PDF·JPG·PNG·WebP 파일만 읽을 수 있습니다.');
  const before = await stat(file);
  if (!before.isFile()) fail('NOT_FILE', '일반 파일만 읽을 수 있습니다.');
  const maximum = fileByteLimit(maxFileBytes);
  if (before.size > maximum) fail('FILE_TOO_LARGE', `서버의 PC 파일 한도는 ${maximum / (1024 * 1024)}MB입니다.`);
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!sameIdentity(opened, before) || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail('FILE_CHANGED', '파일이 변경되었습니다. 다시 요청해 주세요.');
    if (await resolveAllowed(root, relative) !== file) fail('FILE_CHANGED', '파일 위치가 변경되었습니다.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await stat(await resolveAllowed(root, relative));
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !sameIdentity(current, after) || current.size !== after.size || current.mtimeMs !== after.mtimeMs) fail('FILE_CHANGED', '읽는 동안 파일이 변경되었습니다. 다시 요청해 주세요.');
    throwIfAborted(signal);
    return { ok: true, filename: path.basename(file), relative_path: publicRelative(root.path, file), mime_type: MIME[extension], size: bytes.length, mtime: after.mtime.toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') };
  } finally { await handle.close(); }
}
export async function executeJob(roots: LocalRoot[], job: DeviceJob, signal?: AbortSignal, maxFileBytes = MAX_FILE_BYTES): Promise<JobResult> {
  const root = roots.find(item => item.id === job.root_id && item.enabled);
  if (!root) return { ok: false, error: 'ROOT_DISABLED: 허용되지 않은 폴더입니다.' };
  try {
    if (job.operation === 'read') return await readLocalFile(root, job.path ?? '', signal, Math.min(fileByteLimit(maxFileBytes), fileByteLimit(job.max_file_bytes)));
    if (job.operation === 'list' || job.operation === 'search') return await listFiles(root, job, signal);
    return { ok: false, error: 'UNSUPPORTED_OPERATION: 파일 조회 기능만 지원합니다.' };
  } catch (error) {
    if (error instanceof FileAccessError) return { ok: false, error: `${error.code}: ${error.message}` };
    const code = (error as NodeJS.ErrnoException)?.code;
    const messages: Record<string, string> = { ENOENT: '파일 또는 폴더를 찾을 수 없습니다.', EACCES: '파일 접근이 거절되었습니다.', EPERM: '파일을 읽을 권한이 없습니다.', EBUSY: '다른 프로그램에서 파일을 사용하고 있습니다.' };
    return { ok: false, error: `${Object.hasOwn(messages, code ?? '') ? code : 'READ_FAILED'}: ${messages[code ?? ''] ?? '파일을 읽지 못했습니다. PC에서 확인해 주세요.'}` };
  }
}
