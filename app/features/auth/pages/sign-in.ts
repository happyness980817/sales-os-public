import { saveAuthReturn } from '~/common/server/auth-return.server';
import { data, redirectDocument } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';
import { assertSameOrigin, createBackend, publicOrigin } from '~/common/server/backend.server';

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  const backend = createBackend(request);
  if (!backend.supabase) return data({ error: '로그인 연결을 준비하고 있습니다.', emailSent: false }, { status: 503, headers: backend.headers });
  const form = await request.formData();
  await saveAuthReturn(backend.headers, form.get('return_to'));
  const redirectTo = publicOrigin(request) + '/auth/callback';
  try {
    if (form.get('provider') === 'google') {
      const { data: result, error } = await backend.supabase.auth.signInWithOAuth({
        provider: 'google', options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
      });
      if (error || !result.url) throw new Error('oauth');
      return redirectDocument(result.url, { headers: backend.headers });
    }
    const email = String(form.get('email') || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return data({ error: '이메일 주소를 확인해 주세요.', emailSent: false }, { status: 400, headers: backend.headers });
    }
    const { error } = await backend.supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirectTo } });
    if (error) throw new Error('email');
    return data({ error: '', emailSent: true }, { headers: backend.headers });
  } catch {
    return data({ error: '로그인을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.', emailSent: false }, { status: 503, headers: backend.headers });
  }
}
