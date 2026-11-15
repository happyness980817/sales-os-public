import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, LoaderCircle, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { data, Link, useFetcher, useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router';
import { ServiceIcon } from '~/common/components/icons';
import { Notice } from '~/common/components/ui';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '~/common/components/ui/alert-dialog';
import { CATALOG, isAccountProvider, type ConnectionAccount, type Member } from '~/common/lib/api';
import { useWorkspace } from '~/common/lib/workspace';
import { createBackend, routeError } from '~/common/server/backend.server';
import type { action as connectionAction } from './connection-action';

export { routeHeaders as headers } from '~/common/server/backend.server';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const service = CATALOG.find(row => row.provider === params.provider && isAccountProvider(row.provider));
  if (!service) throw new Response('서비스를 찾을 수 없습니다.', { status: 404 });
  const backend = createBackend(request);
  let items: ConnectionAccount[] = [];
  let memberId = '';
  let error = '';
  try {
    if (await backend.hasSession()) {
      const member = await backend.request<Member>('/me');
      memberId = member.id;
      const result = await backend.request<{ items: ConnectionAccount[] }>('/connections/' + encodeURIComponent(service.provider) + '/accounts', { headers: { 'X-SalesOS-Member': memberId } });
      items = result.items;
    }
  } catch (cause) { error = routeError(cause); }
  return data({ service, items, memberId, error }, { headers: backend.headers });
}

export default function ConnectionDetailPage() {
  const loaded = useLoaderData<typeof loader>();
  return <ConnectionAccounts key={loaded.service.provider + ':' + loaded.memberId} loaded={loaded}/>;
}

function ConnectionAccounts({ loaded }: { loaded: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const { service, error, memberId } = loaded;
  const { authenticated, member, onLogin, error: workspaceError } = useWorkspace();
  const change = useFetcher<typeof connectionAction>();
  const disconnect = useFetcher<typeof connectionAction>();
  const revalidator = useRevalidator();
  const [remove, setRemove] = useState<ConnectionAccount | null>(null);
  const [removeRequestId, setRemoveRequestId] = useState('');
  const removeInFlight = useRef(false);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const addAccountButton = useRef<HTMLButtonElement | null>(null);
  const sameMember = authenticated && member?.id === memberId;
  const items = sameMember ? loaded.items : [];
  const pending = change.state !== 'idle' || disconnect.state !== 'idle';
  const selectedId = String(disconnect.formData?.get('connection_id') || change.formData?.get('connection_id') || '');
  const connectedCount = items.filter(account => account.connected).length;
  const removeResult = removeRequestId && disconnect.data?.requestId === removeRequestId ? disconnect.data : undefined;
  useEffect(() => {
    if (disconnect.state !== 'idle' || !removeResult) return;
    removeInFlight.current = false;
    if (!removeResult.error) setRemove(null);
  }, [disconnect.state, removeResult]);
  const fields = (intent: string, id?: string) => <>
    <input type="hidden" name="provider" value={service.provider}/>
    <input type="hidden" name="member_id" value={memberId}/>
    <input type="hidden" name="intent" value={intent}/>
    {id && <input type="hidden" name="connection_id" value={id}/>}
  </>;
  const confirmDisconnect = () => {
    if (!remove || !sameMember || pending || removeInFlight.current) return;
    removeInFlight.current = true;
    const requestId = crypto.randomUUID();
    setRemoveRequestId(requestId);
    void disconnect.submit({ provider: service.provider, member_id: memberId, intent: 'disconnect', connection_id: remove.id, requestId }, { method: 'post', action: '/connections/manage' });
  };
  return <section className="page max-w-3xl!">
    <div className="mb-9 flex items-center justify-between">
      <Link to="/connections" className="inline-flex items-center gap-2 text-sm text-muted hover:text-white"><ArrowLeft size={18}/>서비스 연결</Link>
      <button className="icon-button" aria-label="계정 상태 새로고침" onClick={() => void revalidator.revalidate()} disabled={pending || revalidator.state !== 'idle'}><RefreshCw size={18} className={revalidator.state !== 'idle' ? 'spin' : ''}/></button>
    </div>
    <div className="flex items-center gap-5 [&_.service-icon]:size-16 [&_.service-icon]:rounded-2xl">
      <ServiceIcon provider={service.provider}/>
      <div><h1 className="text-2xl font-semibold tracking-tight">{service.name}</h1><p className="mt-1 text-sm text-muted">{service.provider === 'notion' ? 'Notion' : 'Google'} 제공</p></div>
    </div>
    <p className="mt-6 leading-7 text-zinc-300">{service.description}. 계정을 추가하거나 연결 상태를 관리하세요.</p>
    <p className="mt-5 flex items-center gap-2 text-sm text-muted"><Check size={16}/>계정 {connectedCount}개 연결됨</p>
    {(error || workspaceError || change.data?.error) && <div className="mt-6"><Notice error>{error || workspaceError || change.data?.error}</Notice></div>}
    {change.data?.message && !pending && <div className="mt-6"><Notice>{change.data.message}</Notice></div>}
    {removeResult?.message && !pending && !remove && <div className="mt-6"><Notice>{removeResult.message}</Notice></div>}
    <h2 className="mb-4 mt-9 text-base font-medium">계정</h2>
    <div className="space-y-3">
      {items.map(account => <div key={account.id} className="rounded-2xl border border-line bg-panel px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1"><p className="truncate font-medium" title={account.account}>{account.account || '연결된 계정'}</p><p className="mt-1 text-xs text-muted">{account.connected ? '연결됨' : '다시 연결이 필요합니다'}</p></div>
          <button type="button" role="switch" aria-checked={account.connected} aria-label={`${account.account || '계정'} 연결 해제`} aria-haspopup="dialog" className={`toggle${account.connected ? ' is-on' : ''}`} disabled={pending || !sameMember} onClick={event => { removeTrigger.current = event.currentTarget; setRemoveRequestId(''); setRemove(account); }}>
            {pending && selectedId === account.id ? <LoaderCircle size={13} className="spin"/> : <span/>}
          </button>
        </div>
        {!account.connected && <change.Form method="post" action="/connections/manage" className="mt-3">{fields('connect', account.id)}<button className="text-button text-sm" disabled={pending || !sameMember}>다시 연결</button></change.Form>}
      </div>)}
      {sameMember ? <change.Form method="post" action="/connections/manage">
        {fields('connect')}
        <button ref={addAccountButton} className="flex w-full items-center justify-between rounded-2xl border border-line bg-panel px-5 py-5 text-left font-medium transition-colors hover:bg-raised disabled:opacity-50" disabled={pending}><span>계정 추가</span>{pending && !selectedId ? <LoaderCircle size={20} className="spin"/> : <Plus size={22}/>}</button>
      </change.Form> : <button ref={addAccountButton} className="flex w-full items-center justify-between rounded-2xl border border-line bg-panel px-5 py-5 text-left font-medium hover:bg-raised" onClick={onLogin}><span>계정 추가</span><Plus size={22}/></button>}
    </div>
    {!items.length && <p className="mt-4 text-sm leading-6 text-muted">{sameMember ? service.provider === 'notion' ? '아직 연결한 Notion 워크스페이스가 없습니다.' : '아직 연결한 계정이 없습니다. 개인용과 업무용 계정을 함께 추가할 수 있습니다.' : '로그인한 뒤 본인의 서비스 계정을 추가해 주세요.'}</p>}
    {sameMember && service.provider === 'notion' && <p className="mt-4 text-sm leading-6 text-muted">Notion은 현재 한 워크스페이스를 연결할 수 있습니다. 다른 계정을 연결하면 기존 연결이 변경됩니다.</p>}
    <div className="privacy-note mt-10!"><ShieldCheck size={16}/><p>추가한 계정은 본인만 사용할 수 있습니다.<br/>토글을 누르면 계정 연결을 해제할 수 있습니다.</p></div>
    <AlertDialog open={Boolean(remove) && sameMember} onOpenChange={open => { if (!open && !pending && !removeInFlight.current) setRemove(null); }}>
      <AlertDialogContent aria-busy={disconnect.state !== 'idle'} onEscapeKeyDown={event => { if (pending || removeInFlight.current) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); const target = removeTrigger.current?.isConnected ? removeTrigger.current : addAccountButton.current; target?.focus(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>계정 연결 해제</AlertDialogTitle>
          <AlertDialogDescription className="break-words">{remove?.account || '선택한 계정'} 계정의 {service.name} 연결을 해제하시겠어요? 연결을 해제하면 이 계정의 자료를 더 이상 사용할 수 없습니다.</AlertDialogDescription>
        </AlertDialogHeader>
        {removeResult?.error && !pending && <Notice error>{removeResult.error}</Notice>}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>취소</AlertDialogCancel>
          <AlertDialogAction type="button" className="button-danger" disabled={pending || !sameMember} onClick={event => { event.preventDefault(); confirmDisconnect(); }}>
            {disconnect.state !== 'idle' && <LoaderCircle size={16} className="spin"/>}{disconnect.state !== 'idle' ? '연결 해제 중…' : '연결 해제'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
