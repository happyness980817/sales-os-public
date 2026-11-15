import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, FolderOpen, LoaderCircle, MessageSquare, Pencil, Plus, RefreshCw } from 'lucide-react';
import { Link, useFetcher, useLoaderData, useRevalidator, type ActionFunctionArgs, type LoaderFunctionArgs, type ClientLoaderFunctionArgs } from 'react-router';
import { Empty, Notice } from '~/common/components/ui';
import { dateLabel } from '~/common/lib/api';
import { useWorkspace } from '~/common/lib/workspace';
import { readProjectRouteCache, useProjectRouteCache } from '~/common/lib/project-route-cache';
import type { Project } from '~/common/lib/projects';
import { ProjectSummary } from '../components/project-summary';
import { loadProject, updateProject } from '../server/projects.server';

export { routeHeaders as headers } from '~/common/server/backend.server';
export function loader({ request, params }: LoaderFunctionArgs) { return loadProject(request, params.projectId); }
export function action({ request, params }: ActionFunctionArgs) { return updateProject(request, params.projectId); }

export function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
  return readProjectRouteCache(request, () => serverLoader<typeof loader>());
}

export default function ProjectDetailPage() {
  const loaded = useLoaderData<typeof loader>();
  const { authenticated, member, onLogin } = useWorkspace();
  useProjectRouteCache(loaded, member?.id);
  const revalidator = useRevalidator();
  const ownPage = authenticated && member?.id === loaded.memberId;
  if (!authenticated) return <section className="page"><Link to="/projects" className="inline-flex items-center gap-2 text-sm text-muted"><ArrowLeft size={16}/>프로젝트</Link><Empty icon={<FolderOpen size={27}/>} title="프로젝트를 확인하세요" action={<button className="button button-primary" onClick={onLogin}>로그인</button>}>로그인하면 프로젝트 요약과 이전 대화를 확인할 수 있습니다.</Empty></section>;
  if (!ownPage || !loaded.project) return <section className="page"><Link to="/projects" className="mb-6 inline-flex items-center gap-2 text-sm text-muted"><ArrowLeft size={16}/>프로젝트</Link><Notice error action={<button className="text-button" onClick={() => void revalidator.revalidate()}>재시도</button>}>{loaded.error || '프로젝트를 불러오지 못했습니다.'}</Notice></section>;
  return <ProjectWorkspace key={loaded.project.id + ':' + loaded.memberId} project={loaded.project} loaded={loaded}/>;
}

function ProjectWorkspace({ project, loaded }: { project: Project; loaded: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const save = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [revision, setRevision] = useState(project.revision);
  const [submitted, setSubmitted] = useState(false);
  const pending = save.state !== 'idle';
  const projectPath = '/projects/' + encodeURIComponent(project.id);
  const chatPath = projectPath + '/chat';
  useEffect(() => {
    if (save.state === 'idle' && save.data?.project && !save.data.error) setEditing(false);
  }, [save.state, save.data]);
  function edit() {
    setName(project.name); setRevision(project.revision); setSubmitted(false); setEditing(true);
  }
  return <section className="page">
    <div className="mb-7 flex items-center justify-between"><Link to="/projects" className="inline-flex items-center gap-2 text-sm text-muted hover:text-white"><ArrowLeft size={17}/>프로젝트</Link><button className="icon-button" aria-label="프로젝트 새로고침" disabled={pending || revalidator.state !== 'idle'} onClick={() => void revalidator.revalidate()}><RefreshCw size={17} className={revalidator.state !== 'idle' ? 'spin' : ''}/></button></div>
    <div className="mb-8 flex items-start justify-between gap-5 max-small:flex-col"><div className="min-w-0"><div className="flex items-start gap-2"><h1 className="text-2xl font-semibold tracking-tight wrap-anywhere">{project.name}</h1><button className="icon-button shrink-0" aria-label="프로젝트 이름 변경" onClick={edit} disabled={pending}><Pencil size={15}/></button></div><p className="mt-2 text-xs text-muted"><time dateTime={project.updated_at}>{dateLabel(project.updated_at)}</time> 업데이트</p></div><Link to={chatPath} className="button button-primary shrink-0"><Plus size={17}/>새 대화</Link></div>
    {loaded.error && <div className="mb-5"><Notice error>{loaded.error}</Notice></div>}
    {editing && <save.Form method="post" className="mb-5 space-y-4 rounded-xl border border-line bg-panel p-5" onSubmit={() => setSubmitted(true)}>
      <input type="hidden" name="intent" value="save"/><input type="hidden" name="member_id" value={loaded.memberId}/><input type="hidden" name="revision" value={revision}/>
      <div><label htmlFor="edit-project-name" className="mb-2 block text-sm font-medium">프로젝트 이름</label><input id="edit-project-name" name="name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={pending} className="w-full rounded-xl border border-line bg-black px-4 py-3 outline-none focus:border-zinc-500"/></div>
      {submitted && save.data?.error && !pending && <Notice error>{save.data.error}</Notice>}
      <div className="flex justify-end gap-3"><button type="button" className="button button-secondary" disabled={pending} onClick={() => setEditing(false)}>취소</button><button className="button button-primary" disabled={pending || !name.trim()}>{pending && <LoaderCircle size={16} className="spin"/>}저장</button></div>
    </save.Form>}
    {!editing && submitted && save.data?.project && !save.data.error && <div className="mb-4"><Notice>프로젝트 이름을 변경했습니다.</Notice></div>}
    <ProjectSummary project={project} memberId={loaded.memberId} hasThreads={!loaded.error && (loaded.threads.items.length > 0 || Boolean(loaded.cursor))}/>
    <section aria-labelledby="project-chats-heading" className="mt-10">
      <div className="mb-4 flex items-center justify-between"><h2 id="project-chats-heading" className="text-base font-medium">대화</h2><Link to={chatPath} className="inline-flex items-center gap-2 text-sm text-muted hover:text-white"><Plus size={15}/>새 대화</Link></div>
      {loaded.threads.items.length ? <div className="overflow-hidden rounded-xl border border-line bg-panel">{loaded.threads.items.map(thread => <Link key={thread.id} to={chatPath + '?thread=' + encodeURIComponent(thread.id)} className="flex items-center gap-3 border-b border-line px-5 py-4 last:border-0 hover:bg-raised"><MessageSquare size={18} className="shrink-0 text-muted"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{thread.title || '새 대화'}</p><p className="mt-1 text-xs text-muted"><time dateTime={thread.created_at}>{dateLabel(thread.created_at)}</time></p></div><ArrowRight size={16} className="shrink-0 text-muted"/></Link>)}</div> : !loaded.error && <div className="rounded-xl border border-dashed border-line py-9 text-center"><p className="text-sm text-muted">{loaded.cursor ? '이 페이지에는 대화가 없습니다.' : '이 프로젝트의 첫 대화를 시작해 보세요.'}</p><Link to={chatPath} className="button button-secondary mt-4 inline-flex"><MessageSquare size={16}/>대화 시작</Link></div>}
      {(loaded.cursor || loaded.threads.has_more) && <nav aria-label="프로젝트 대화 목록 페이지" className="mt-5 flex justify-center gap-3">{loaded.cursor && <Link to={projectPath} className="button button-secondary compact">처음</Link>}{loaded.threads.has_more && loaded.threads.after && <Link to={projectPath + '?after=' + encodeURIComponent(loaded.threads.after)} className="button button-secondary compact">다음<ArrowRight size={15}/></Link>}</nav>}
    </section>
  </section>;
}
