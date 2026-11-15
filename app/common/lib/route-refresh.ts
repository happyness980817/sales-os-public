import { useCallback, useEffect, useRef, useState } from 'react';
import { useFetcher, useLocation } from 'react-router';

// Poll only this route. Unlike revalidator.revalidate(), fetcher.load does not
// refresh the workspace or discard other pages already visited in this tab.
export function useRouteRefresh<T>(loaded: T) {
  const fetcher = useFetcher<T>();
  const location = useLocation();
  const latest = useRef({ loaded, path: location.pathname + location.search, state: fetcher.state });
  latest.current = { loaded, path: location.pathname + location.search, state: fetcher.state };
  const requested = useRef<{ original: T; path: string } | null>(null);
  const [replacement, setReplacement] = useState<{ original: T; path: string; value: T } | null>(null);
  const load = fetcher.load;
  const refresh = useCallback(() => {
    const current = latest.current;
    if (current.state !== 'idle' || requested.current) return;
    requested.current = { original: current.loaded, path: current.path };
    const url = new URL(current.path, 'https://salesos.invalid');
    url.searchParams.set('_refresh', '1');
    void load(url.pathname + url.search);
  }, [load]);
  useEffect(() => {
    if (fetcher.state !== 'idle' || !requested.current) return;
    const request = requested.current;
    requested.current = null;
    if (fetcher.data !== undefined && request.original === latest.current.loaded && request.path === latest.current.path) {
      setReplacement({ ...request, value: fetcher.data as T });
    }
  }, [fetcher.state, fetcher.data]);
  return {
    data: replacement?.original === loaded && replacement.path === latest.current.path ? replacement.value : loaded,
    refresh,
    refreshing: fetcher.state !== 'idle',
  };
}
