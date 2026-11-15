import { data, redirectDocument } from 'react-router';
import type { ActionFunctionArgs } from 'react-router';
import { CATALOG, isAccountProvider } from '~/common/lib/api';
import { assertSameOrigin, BackendError, createBackend, routeError } from '~/common/server/backend.server';

export { routeHeaders as headers } from '~/common/server/backend.server';

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  const backend = createBackend(request);
  const form = await request.formData();
  const memberId = String(form.get('member_id') || '');
  const headers = { 'X-SalesOS-Member': memberId };
  const intent = String(form.get('intent') || '');
  const provider = String(form.get('provider') || '');
  const requestId = String(form.get('requestId') || '').slice(0, 100);
  try {
    if (intent === 'enroll') {
      const kind = String(form.get('kind'));
      if (kind !== 'pc' && kind !== 'line') throw new BackendError('연결할 기기를 확인해 주세요.', 400);
      const pairing = await backend.request<{ code: string; expires_at?: string; url?: string }>(
        kind === 'pc' ? '/device-enrollments' : '/line/link-code',
        { method: 'POST', headers, body: '{}' });
      return data({ error: '', requestId, pairing: { kind, ...pairing }, message: '' }, { headers: backend.headers });
    }
    const service = CATALOG.find(c => c.provider === provider);
    if (!service) throw new BackendError('서비스를 확인해 주세요.', 400);
    const accountProvider = isAccountProvider(provider);
    const connectionId = String(form.get('connection_id') || '');
    if (connectionId && !/^[a-zA-Z0-9_:-]{1,200}$/.test(connectionId)) throw new BackendError('연결된 계정을 확인해 주세요.', 400);
    if (accountProvider && !memberId) throw new BackendError('다시 로그인한 후 연결을 관리해 주세요.', 401);
    const path = '/connections/' + encodeURIComponent(provider);
    if (intent === 'connect') {
      if (!accountProvider) throw new BackendError('기기 연결 메뉴를 이용해 주세요.', 400);
      const result = await backend.request<{ url: string }>(path + '/start', {
        method: 'POST', headers, body: JSON.stringify(connectionId ? { connection_id: connectionId } : {}),
      });
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !['accounts.google.com', 'api.notion.com', 'www.notion.so', 'notion.so'].includes(url.hostname)) {
        throw new BackendError('연결 주소를 확인할 수 없습니다.', 502);
      }
      return redirectDocument(url.href, { headers: backend.headers });
    }
    // Never fall back to a provider-wide update when the user selected one account.
    if (accountProvider && !connectionId) throw new BackendError('변경할 계정을 선택해 주세요.', 400);
    const accountPath = accountProvider ? path + '/accounts/' + encodeURIComponent(connectionId) : path;
    if (intent === 'toggle') {
      if (!['true', 'false'].includes(String(form.get('enabled')))) throw new BackendError('계정 사용 상태를 확인해 주세요.', 400);
      const enabled = form.get('enabled') === 'true';
      await backend.request(accountPath, { method: 'PATCH', headers, body: JSON.stringify({ enabled }) });
      return data({ error: '', requestId, pairing: null, message: enabled ? service.name + ' 자료를 대화에 사용합니다.' : service.name + ' 자료 사용을 껐습니다.' }, { headers: backend.headers });
    }
    if (intent === 'disconnect') {
      await backend.request(accountPath, { method: 'DELETE', headers });
      return data({ error: '', requestId, pairing: null, message: service.name + ' 계정 연결을 해제했습니다.' }, { headers: backend.headers });
    }
    throw new BackendError('요청을 확인해 주세요.', 400);
  } catch (error) {
    return data({ error: routeError(error), requestId, pairing: null, message: '' }, { status: error instanceof BackendError ? error.status : 400, headers: backend.headers });
  }
}
