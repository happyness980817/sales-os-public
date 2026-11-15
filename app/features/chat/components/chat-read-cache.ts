// Each mounted ChatKit panel owns this cache. Nothing is shared with another
// employee, persisted to disk, or used to authorize a server-side action.
export function createChatReadCache(fetcher: typeof fetch, ttlMs = 5 * 60_000) {
  const entries = new Map<string, { body: string; contentType: string; expires: number }>();
  let generation = 0;
  function clear() { generation++; entries.clear(); }
  const cachedFetch: typeof fetch = async (input, init = {}) => {
    const signal = init.signal || (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://salesos.local');
    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.pathname !== '/api/chatkit' || method !== 'POST') return fetcher(input, init);
    let body: string;
    try { body = typeof init.body === 'string' ? init.body : input instanceof Request && init.body === undefined ? await input.clone().text() : ''; }
    catch { return fetcher(input, init); }
    let type: string;
    try { type = JSON.parse(body).type; } catch { return fetcher(input, init); }
    if (!['threads.get_by_id', 'threads.list', 'items.list'].includes(type)) {
      clear();
      try { return await fetcher(input, init); } finally { clear(); }
    }
    const cached = entries.get(body);
    if (cached && cached.expires > Date.now()) {
      entries.delete(body); entries.set(body, cached);
      return new Response(cached.body, { headers: { 'Content-Type': cached.contentType } });
    }
    entries.delete(body);
    const started = generation;
    const response = await fetcher(input, init);
    const contentType = response.headers.get('Content-Type') || '';
    if (response.ok && contentType.includes('application/json')) {
      const text = await response.clone().text();
      if (started === generation && !signal?.aborted && text.length <= 1_000_000) {
        entries.set(body, { body: text, contentType, expires: Date.now() + ttlMs });
        while (entries.size > 20) entries.delete(entries.keys().next().value!);
      }
    }
    return response;
  };
  return { fetch: cachedFetch, clear };
}
