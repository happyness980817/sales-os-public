import { useEffect } from 'react';
import { useLocation } from 'react-router';

type ProjectRouteData = { memberId: string; error: string };
const TTL = 5 * 60_000;
const MAX_ENTRIES = 20;

export function projectRouteCacheKey(address: string) {
  const url = new URL(address, 'https://salesos.invalid');
  url.searchParams.delete('new');
  url.searchParams.delete('thread');
  url.searchParams.sort();
  return url.pathname + url.search;
}

// An instance belongs to one browser tab. No tokens, localStorage or server cache.
export function createProjectRouteCache(now = Date.now, ttl = TTL, maximum = MAX_ENTRIES) {
  let owner = '', generation = 0;
  const entries = new Map<string, { value: ProjectRouteData; expires: number }>();
  const versions = new WeakMap<ProjectRouteData, number>();
  function invalidate() { generation++; entries.clear(); }
  function setOwner(memberId: string) {
    if (owner !== memberId) { invalidate(); owner = memberId; }
  }
  function seed<T extends ProjectRouteData>(key: string, value: T) {
    if (!owner || value.memberId !== owner || value.error) return;
    if (versions.has(value) && versions.get(value) !== generation) return;
    versions.set(value, generation);
    if (entries.get(key)?.value === value) return;
    entries.delete(key);
    entries.set(key, { value, expires: now() + ttl });
    while (entries.size > maximum) entries.delete(entries.keys().next().value!);
  }
  async function read<T extends ProjectRouteData>(key: string, load: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    const entry = entries.get(key);
    if (owner && entry && entry.expires > now() && entry.value.memberId === owner) return entry.value as T;
    entries.delete(key);
    const started = generation;
    const result = await load();
    signal.throwIfAborted();
    // A mutation or account change may finish while this request is in flight.
    // Re-read using the current session instead of restoring its older result.
    if (started !== generation) return read(key, load, signal);
    versions.set(result, generation);
    seed(key, result);
    return result;
  }
  return { setOwner, invalidate, seed, read };
}

let browserCache: ReturnType<typeof createProjectRouteCache> | undefined;
function cache() {
  if (typeof window === 'undefined') return undefined;
  return browserCache ??= createProjectRouteCache();
}
export function invalidateProjectRouteCache() { cache()?.invalidate(); }
export function setProjectRouteCacheOwner(memberId: string) { cache()?.setOwner(memberId); }
export function resetProjectRouteCache() {
  cache()?.invalidate();
  cache()?.setOwner('');
}
export function readProjectRouteCache<T extends ProjectRouteData>(request: Request, serverLoader: () => Promise<T>) {
  const current = cache();
  if (!current || new URL(request.url).searchParams.has('auth_error')) return serverLoader();
  return current.read(projectRouteCacheKey(request.url), serverLoader, request.signal);
}

// Seed initial SSR data after hydration; identity always comes from the parent.
export function useProjectRouteCache(value: ProjectRouteData, memberId: string | undefined) {
  const location = useLocation();
  useEffect(() => {
    const current = cache();
    if (!current) return;
    current.setOwner(memberId || '');
    if (!new URLSearchParams(location.search).has('auth_error')) {
      current.seed(projectRouteCacheKey(location.pathname + location.search), value);
    }
    // URL-only ChatKit thread changes must not reinsert an invalidated overview.
  }, [value, memberId]);
}
