import { useEffect } from 'react';
import { ArrowRight, FileText, Folder, FolderOpen, LoaderCircle, Monitor, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { dateLabel, type Device, type Job } from '~/common/lib/api';
import { Notice, Empty } from '~/common/components/ui';
import { data, Form, redirect, useActionData, useLoaderData, useNavigation, useRevalidator, useSearchParams } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { useWorkspace } from '~/common/lib/workspace';
import { assertSameOrigin, createBackend, routeError } from '~/common/server/backend.server';
import { STATUS } from '~/features/jobs/status';
export { routeHeaders as headers } from '~/common/server/backend.server';

type LocalFile = { name: string; path?: string; relative_path?: string; size?: number; is_directory?: boolean };
const pendingStatuses = ['pending', 'processing', 'running', 'waiting_device', 'retry_wait'];

export async function loader({ request }: LoaderFunctionArgs) {
  const backend = await createBackend(request);
  let devices: Device[] = [];
  try {
    if (!await backend.hasSession()) return data({ devices, job: null as Job | null, error: '' }, { headers: backend.headers });
    devices = (await backend.request<{ items: Device[] }>('/devices')).items;
    const jobId = new URL(request.url).searchParams.get('job');
    if (jobId && jobId.length > 100) return data({ devices, job: null as Job | null, error: '작업 주소를 확인해 주세요.' }, { headers: backend.headers });
    const job = jobId ? await backend.request<Job>(`/jobs/${encodeURIComponent(jobId)}`) : null;
    return data({ devices, job, error: '' }, { headers: backend.headers });
  } catch (error) {
    return data({ devices, job: null as Job | null, error: routeError(error) }, { headers: backend.headers });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  const backend = await createBackend(request);
  try {
    const form = await request.formData();
    const headers = { 'X-SalesOS-Member': String(form.get('member_id') || '') };
    const intent = form.get('intent');
    const device = form.get('device_id');
    const root = form.get('root_id');
    const query = form.get('query') || '';
    const path = form.get('path');
    if (!['search', 'read'].includes(String(intent)) || typeof device !== 'string' || !device || device.length > 100 || typeof root !== 'string' || !root || root.length > 100 || typeof query !== 'string' || query.length > 300 || (intent === 'read' && (typeof path !== 'string' || !path || path.length > 1000))) {
      return data({ error: '컴퓨터와 폴더, 파일 요청을 확인해 주세요.' }, { status: 400, headers: backend.headers });
    }
    const job = await backend.request<Job>(`/local-files/${intent}`, {
      method: 'POST', headers,
      body: JSON.stringify({ device_id: device, root_id: root, ...(intent === 'read' ? { path } : { query }) }),
    });
    if (intent === 'read') return redirect('/jobs', { headers: backend.headers });
    const params = new URLSearchParams({ device, root, query, job: job.id });
    return redirect(`/files?${params}`, { headers: backend.headers });
  } catch (error) {
    return data({ error: routeError(error) }, { headers: backend.headers });
  }
}

export default function FilesPage() {
  const { authenticated, onLogin, enroll, member } = useWorkspace();
  const { devices, job, error: loadError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { revalidate, state: revalidationState } = useRevalidator();
  const [params, setParams] = useSearchParams();
  const selected = devices.find(device => device.id === params.get('device')) || devices[0];
  const roots = selected?.roots.filter(root => root.enabled) || [];
  const rootId = roots.find(root => root.id === params.get('root'))?.id || roots[0]?.id || '';
  const deviceId = selected?.id || '';
  const query = params.get('query') || '';
  const busy = navigation.state !== 'idle';
  const error = actionData?.error || loadError;
  const result = job?.result;
  const files: LocalFile[] = result && typeof result === 'object' && 'files' in result && Array.isArray(result.files)
    ? result.files.filter((file): file is LocalFile => Boolean(file && typeof file === 'object' && typeof file.name === 'string'))
    : [];
  const onEnroll = () => void enroll('pc');

  function changeSelection(kind: 'device' | 'root', value: string) {
    const next = new URLSearchParams(params);
    next.set(kind, value);
    next.delete('job');
    if (kind === 'device') next.delete('root');
    setParams(next, { replace: true, preventScrollReset: true });
  }
  useEffect(() => {
    if (!authenticated || !job || !pendingStatuses.includes(job.status)) return;
    const timer = setInterval(() => { if (!document.hidden) void revalidate(); }, 2500);
    return () => clearInterval(timer);
  }, [authenticated, job?.id, job?.status, revalidate]);

  return <section className="page"><div className="page-heading"><div><div className="eyebrow">ON YOUR COMPUTER</div><h1>로컬</h1><p>선택한 폴더의 자료를 대화에 활용하세요.</p></div><button className="button button-secondary compact" onClick={authenticated ? onEnroll : onLogin}><Plus size={16}/>PC 연결</button></div>{authenticated && error && <Notice error>{error}</Notice>}
    {!authenticated ? <Empty icon={<FolderOpen size={28}/>} title="내 컴퓨터의 자료와 연결하세요" action={<button className="button button-primary" onClick={onLogin}>로그인</button>}>지정한 폴더에서 필요한 파일만 읽어옵니다.</Empty> : !devices.length && !error ? <Empty icon={<Monitor size={29}/>} title="아직 연결된 PC가 없습니다" action={<button className="button button-primary" onClick={onEnroll}>PC 연결하기<ArrowRight size={16}/></button>}>PC 연결 프로그램에서 폴더를 선택하면<br/>웹과 LINE에서 자료를 찾아 읽을 수 있습니다.</Empty> : devices.length > 0 ? <>
      <div className="device-card"><Monitor size={23}/><div><strong>{selected?.name || '내 컴퓨터'}</strong><span>{selected?.status === 'online' ? '연결됨' : '연결 대기'} · 최근 접속 {dateLabel(selected?.last_seen_at)}</span></div><button className="icon-button" aria-label="PC 상태 새로고침" onClick={() => void revalidate()} disabled={busy || revalidationState !== 'idle'}><RefreshCw size={17} className={revalidationState !== 'idle' ? 'spin' : ''}/></button></div>
      <Form method="post" className="file-search-form"><input type="hidden" name="member_id" value={member?.id || ''}/><input type="hidden" name="intent" value="search"/><div className="select-pair"><label>컴퓨터<select name="device_id" value={deviceId} onChange={event => changeSelection('device', event.target.value)} disabled={busy}>{devices.map(device => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><label>허용 폴더<select name="root_id" value={rootId} onChange={event => changeSelection('root', event.target.value)} disabled={busy}>{!roots.length && <option value="">PC에서 폴더를 선택해 주세요</option>}{roots.map(root => <option key={root.id} value={root.id}>{root.name}</option>)}</select></label></div><label className="search-field file-search"><Search size={17}/><input key={query} name="query" aria-label="로컬 파일 이름 검색" defaultValue={query} maxLength={300} placeholder="파일 이름으로 검색"/><button className="button button-primary compact" disabled={busy || !rootId}>{busy ? <LoaderCircle size={16} className="spin"/> : '검색'}</button></label></Form>
      {job && <Notice error={job.status === 'failed'}>{job.error || STATUS[job.status] || job.status}{job.status === 'waiting_device' && ' · PC와 연결 프로그램이 켜지면 계속합니다.'}</Notice>}
      {files.length > 0 && <div className="file-results">{files.map((file, index) => <Form method="post" key={`${file.path || file.name}-${index}`}><input type="hidden" name="member_id" value={member?.id || ''}/><input type="hidden" name="intent" value="read"/><input type="hidden" name="device_id" value={deviceId}/><input type="hidden" name="root_id" value={rootId}/><input type="hidden" name="path" value={file.relative_path || file.path || file.name}/><button className="file-row" disabled={busy || file.is_directory}>{file.is_directory ? <Folder size={20}/> : <FileText size={20}/>}<span><strong>{file.name}</strong><small>{file.relative_path || file.path || ''}</small></span><span>{file.is_directory ? '폴더' : '읽기'}</span></button></Form>)}</div>}
      {job && ['succeeded', 'completed'].includes(job.status) && files.length === 0 && <p className="muted centered">검색된 파일이 없습니다.</p>}
    </> : null}
    <div className="privacy-note"><ShieldCheck size={16}/><p>허용한 폴더만 읽습니다. 파일을 수정하거나 삭제하지 않습니다.</p></div>
  </section>;
}
