import { takeAuthReturn } from '~/common/server/auth-return.server';
import { redirect } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { createBackend } from '~/common/server/backend.server';

export async function loader({ request }: LoaderFunctionArgs) {
  const backend = createBackend(request);
  const returnTo = await takeAuthReturn(request, backend.headers);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const cancelled = url.searchParams.get('error') === 'access_denied';
  if (!url.searchParams.has('error') && code && backend.supabase) {
    try {
      const flowId = url.searchParams.get('sb_flow_id');
      const { data, error } = await backend.supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
      if (!error && data.session) return redirect(returnTo, { headers: backend.headers });
    } catch { /* Use a fixed error code, never provider details or tokens. */ }
  }
  try { await backend.supabase?.auth.signOut({ scope: 'local' }); } catch { /* The error page never accepts a previous identity. */ }
  return redirect('/chat?auth_error=' + (cancelled ? 'cancelled' : 'expired'), { headers: backend.headers });
}
