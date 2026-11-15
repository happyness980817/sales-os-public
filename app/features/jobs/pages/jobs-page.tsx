import { useEffect, useState } from 'react';
import { ArrowRight, Check, CircleAlert, CircleCheck, Clock3, RefreshCw } from 'lucide-react';
import { dateLabel, type Job } from '~/common/lib/api';
import { Modal, Notice, Empty } from '~/common/components/ui';
import { data, useFetcher, useLoaderData, useNavigate, useRevalidator } from 'react-router';
import type { ActionFunctionArgs, LoaderFunctionArgs, ClientLoaderFunctionArgs } from 'react-router';
import { readProjectRouteCache, useProjectRouteCache } from '~/common/lib/project-route-cache';
import { useWorkspace } from '~/common/lib/workspace';
import { assertSameOrigin, createBackend, routeError } from '~/common/server/backend.server';
export { routeHeaders as headers } from '~/common/server/backend.server';
import { useRouteRefresh } from '~/common/lib/route-refresh';
import { STATUS } from '../status';

export async function loader({ request }: LoaderFunctionArgs) {
  const backend = await createBackend(request);
  try {
    if (!await backend.hasSession()) return data({ items: [] as Job[], memberId: '', error: '' }, { headers: backend.headers });
    const { member_id: memberId, ...result } = await backend.request<{ items: Job[]; member_id: string }>('/jobs');
    return data({ ...result, memberId, error: '' }, { headers: backend.headers });
  } catch (error) {
    return data({ items: [] as Job[], memberId: '', error: routeError(error) }, { headers: backend.headers });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  const backend = await createBackend(request);
  try {
    const form = await request.formData();
    const headers = { 'X-SalesOS-Member': String(form.get('member_id') || '') };
    const id = String(form.get('job_id') || '');
    if (form.get('intent') !== 'cancel' || !id || id.length > 100) return data({ error: '작업 요청을 확인해 주세요.', cancelledId: '' }, { status: 400, headers: backend.headers });
    await backend.request(`/jobs/${encodeURIComponent(id)}/actions`, { method: 'POST', headers, body: JSON.stringify({ action: 'cancel' }) });
    return data({ error: '', cancelledId: id }, { headers: backend.headers });
  } catch (error) {
    return data({ error: routeError(error), cancelledId: '' }, { headers: backend.headers });
  }
}

const isActive = (job: Job) => ['pending', 'processing', 'running', 'waiting_input', 'waiting_device', 'retry_wait'].includes(job.status);

export function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
  return readProjectRouteCache(request, () => serverLoader<typeof loader>());
}

export default function JobsPage() {
  const { authenticated, onLogin, member } = useWorkspace();
  const initial = useLoaderData<typeof loader>();
  const { data: loaded, refresh } = useRouteRefresh(initial);
  useProjectRouteCache(loaded, member?.id);
  const jobs = authenticated && loaded.memberId === member?.id ? loaded.items : [];
  const loadError = loaded.error;
  const revalidator = useRevalidator();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = jobs.find(job => job.id === selectedId);
  const loading = revalidator.state !== 'idle' || fetcher.state !== 'idle';
  const error = fetcher.data?.error || loadError;
  const { revalidate } = revalidator;

  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [authenticated, refresh]);
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.cancelledId) setSelectedId(null);
  }, [fetcher.state, fetcher.data]);

  const shown = jobs.filter(job => filter === 'all' || (filter === 'active' ? isActive(job) : ['succeeded', 'completed'].includes(job.status)));
  return <section className="page"><div className="page-heading"><div><div className="eyebrow">IN PROGRESS & DONE</div><h1>내 작업</h1><p>맡긴 일의 진행 상황과 결과를 확인하세요.</p></div><button className="icon-button" aria-label="작업 새로고침" onClick={() => void revalidate()} disabled={!authenticated || loading}><RefreshCw size={18} className={loading ? 'spin' : ''}/></button></div>
    <div className="segmented standalone">{[['all', '전체'], ['active', '진행 중'], ['done', '완료']].map(([value, label]) => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {authenticated && error && <Notice error>{error}</Notice>}
    {!authenticated ? <Empty icon={<Clock3 size={26}/>} title="내 작업을 이어가세요" action={<button className="button button-primary" onClick={onLogin}>로그인</button>}>로그인하면 맡긴 작업과 결과를 확인할 수 있습니다.</Empty> : !shown.length && !loading && !error ? <Empty icon={<CircleCheck size={26}/>} title="아직 표시할 작업이 없습니다" action={<button className="button button-secondary" onClick={() => navigate('/chat')}>대화 시작하기<ArrowRight size={15}/></button>}>대화에서 업무를 요청하면 진행 상황이 여기에 표시됩니다.</Empty> : <div className="job-list" aria-busy={loading}>{shown.map(job => <button className="job-row" key={job.id} onClick={() => setSelectedId(job.id)}><span className={`job-status-icon ${['failed', 'unknown'].includes(job.status) ? 'error' : ''}`}>{isActive(job) ? <Clock3 size={19}/> : ['succeeded', 'completed'].includes(job.status) ? <Check size={19}/> : <CircleAlert size={19}/>}</span><span className="job-copy"><strong>{job.title || '업무 처리'}</strong><span>{dateLabel(job.created_at)}</span></span><span className="status-badge">{STATUS[job.status] || job.status}</span></button>)}</div>}
    {authenticated && selected && <Modal title={selected.title || '작업 상세'} onClose={() => setSelectedId(null)}><div className="detail-grid"><span>상태</span><strong>{STATUS[selected.status] || selected.status}</strong><span>요청 시각</span><span>{dateLabel(selected.created_at)}</span></div>{selected.error && <Notice error>{selected.error}</Notice>}{selected.result != null && <pre className="result-preview">{typeof selected.result === 'string' ? selected.result : JSON.stringify(selected.result, null, 2)}</pre>}<div className="modal-actions">{isActive(selected) && <fetcher.Form method="post"><input type="hidden" name="member_id" value={member?.id || ''}/><input type="hidden" name="job_id" value={selected.id}/><button className="button button-secondary" name="intent" value="cancel" disabled={fetcher.state !== 'idle'}>작업 중지</button></fetcher.Form>}<button className="button button-primary" onClick={() => setSelectedId(null)}>닫기</button></div></Modal>}
  </section>;
}
