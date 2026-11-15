import { useEffect, useState } from 'react';
import { ArrowRight, FolderOpen, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import { Link, useFetcher, useLoaderData, useRevalidator, useSearchParams, type ActionFunctionArgs, type LoaderFunctionArgs, type ClientLoaderFunctionArgs } from 'react-router';
import { Empty, Modal, Notice } from '~/common/components/ui';
import { dateLabel } from '~/common/lib/api';
import { useWorkspace } from '~/common/lib/workspace';
import { readProjectRouteCache, useProjectRouteCache } from '~/common/lib/project-route-cache';
import { createProject, loadProjects } from '../server/projects.server';

export { routeHeaders as headers } from '~/common/server/backend.server';
export function loader({ request }: LoaderFunctionArgs) { return loadProjects(request); }
export function action({ request }: ActionFunctionArgs) { return createProject(request); }

export function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
  return readProjectRouteCache(request, () => serverLoader<typeof loader>());
}

export default function ProjectsPage() {
  const loaded = useLoaderData<typeof loader>();
  const { authenticated, member, onLogin } = useWorkspace();
  useProjectRouteCache(loaded, member?.id);
  const create = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const ownPage = authenticated && member?.id === loaded.memberId;
  const items = ownPage ? loaded.items : [];
  const pending = create.state !== 'idle';
  useEffect(() => {
    if (!ownPage || searchParams.get('new') !== '1') return;
    setName(''); setCreating(true);
    const params = new URLSearchParams(searchParams);
    params.delete('new');
    setSearchParams(params, { replace: true });
  }, [ownPage, searchParams, setSearchParams]);
  function startProject() {
    if (!ownPage) { onLogin(); return; }
    setName(''); setCreating(true);
  }
  return <section className="page">
    <div className="page-heading"><div><h1>프로젝트</h1><p>대화와 에이전트의 요약으로 업무를 이어가세요.</p></div><div className="flex items-center gap-2"><button className="icon-button" aria-label="프로젝트 새로고침" disabled={revalidator.state !== 'idle'} onClick={() => void revalidator.revalidate()}><RefreshCw size={18} className={revalidator.state !== 'idle' ? 'spin' : ''}/></button><button className="button button-primary" onClick={startProject}><Plus size={17}/>새 프로젝트</button></div></div>
    {loaded.error && <Notice error action={<button className="text-button" onClick={() => void revalidator.revalidate()}>재시도</button>}>{loaded.error}</Notice>}
    {!authenticated ? <Empty icon={<FolderOpen size={27}/>} title="프로젝트로 업무를 정리하세요" action={<button className="button button-primary" onClick={onLogin}>로그인</button>}>로그인하면 프로젝트별 대화와 요약을 확인할 수 있습니다.</Empty> : <>
      {!!items.length && <div className="overflow-hidden rounded-xl border border-line bg-panel">{items.map(project => <Link key={project.id} to={'/projects/' + encodeURIComponent(project.id)} className="flex items-center gap-4 border-b border-line px-5 py-5 transition-colors last:border-0 hover:bg-raised"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line text-muted"><FolderOpen size={20}/></span><div className="min-w-0 flex-1"><h2 className="truncate text-base font-medium">{project.name}</h2><p className="mt-1 text-xs text-muted"><time dateTime={project.updated_at}>{dateLabel(project.updated_at)}</time> 업데이트</p></div><ArrowRight size={18} className="shrink-0 text-muted"/></Link>)}</div>}
      {!items.length && !loaded.error && <Empty icon={<FolderOpen size={27}/>} title={loaded.cursor ? '이 페이지에는 프로젝트가 없습니다' : '첫 프로젝트를 만들어 보세요'} action={<button className="button button-secondary" onClick={startProject}><Plus size={16}/>새 프로젝트</button>}>이름을 정하고 대화를 시작하면 에이전트가 프로젝트를 요약합니다.</Empty>}
      {(loaded.cursor || loaded.has_more) && <nav aria-label="프로젝트 목록 페이지" className="mt-6 flex justify-center gap-3">{loaded.cursor && <Link to="/projects" className="button button-secondary compact">처음</Link>}{loaded.has_more && loaded.after && <Link to={'/projects?after=' + encodeURIComponent(loaded.after)} className="button button-secondary compact">다음<ArrowRight size={15}/></Link>}</nav>}
    </>}
    {creating && ownPage && <Modal title="새 프로젝트" onClose={() => { if (!pending) setCreating(false); }}>
      <create.Form method="post" className="space-y-5">
        <input type="hidden" name="intent" value="create"/><input type="hidden" name="member_id" value={loaded.memberId}/>
        <div><label htmlFor="project-name" className="mb-2 block text-sm font-medium">프로젝트 이름</label><input id="project-name" name="name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required autoFocus disabled={pending} placeholder="프로젝트 이름을 입력하세요" className="w-full rounded-xl border border-line bg-black px-4 py-3 outline-none focus:border-zinc-500"/></div>
        <p className="text-sm leading-6 text-muted">대화를 시작하면 에이전트가 프로젝트를 요약합니다.</p>
        {create.data?.error && <Notice error>{create.data.error}</Notice>}
        <div className="modal-actions"><button type="button" className="button button-secondary" disabled={pending} onClick={() => setCreating(false)}>취소</button><button className="button button-primary" disabled={pending || !name.trim()}>{pending && <LoaderCircle size={16} className="spin"/>}만들기</button></div>
      </create.Form>
    </Modal>}
  </section>;
}
