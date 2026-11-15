export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}
export function normalizeServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('올바른 SALES-OS 서버 주소를 입력해 주세요.'); }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/') || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal))) throw new Error('서버 주소는 HTTPS 주소여야 합니다. 로컬 개발 서버만 HTTP를 사용할 수 있습니다.');
  return url.origin;
}
export async function request<T>(server: string, endpoint: string, method: string, body: unknown, token?: string, signal?: AbortSignal): Promise<T> {
  const url = `${normalizeServerUrl(server)}${endpoint}`;
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    method, redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const length = Number(response.headers.get('Content-Length'));
  if (length > 1024 * 1024) throw new ApiError(502, '서버 응답이 너무 큽니다.');
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 1024 * 1024) { await reader.cancel(); throw new ApiError(502, '서버 응답이 너무 큽니다.'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let data: any;
  try { data = total ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
  catch { throw new ApiError(response.status, '서버 응답 형식을 확인할 수 없습니다.'); }
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail.slice(0, 240) : '요청을 처리하지 못했습니다.';
    throw new ApiError(response.status, detail);
  }
  return data as T;
}
