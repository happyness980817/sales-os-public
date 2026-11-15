import { data, redirectDocument } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';
import { assertSameOrigin, createBackend } from '~/common/server/backend.server';

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  const backend = createBackend(request);
  try {
    const result = await backend.supabase?.auth.signOut({ scope: 'local' });
    if (result?.error) throw result.error;
    return redirectDocument('/chat', { headers: backend.headers });
  } catch {
    return data({ error: '로그아웃을 완료하지 못했습니다. 다시 시도해 주세요.' }, { status: 503, headers: backend.headers });
  }
}
