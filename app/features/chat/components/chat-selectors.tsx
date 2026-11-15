import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, FolderOpen, LoaderCircle, Plus } from 'lucide-react';
import { useFetcher, useLocation, useNavigate } from 'react-router';
import type { Project } from '~/common/lib/projects';
import type { PublicConfig } from '~/common/lib/api';
import type { loader as projectsLoader } from '~/features/projects/pages/projects-page';

type Props = {
  models: NonNullable<PublicConfig['chat_models']>;
  selectedModelId: string;
  onModelChange: (id: string) => void;
  projects: Project[];
  currentProject?: Project;
  currentProjectId?: string;
  memberId?: string;
  onLogin: () => void;
};
const optionClass = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-normal hover:bg-raised focus-visible:bg-raised';

export function ChatSelectors({ models, selectedModelId, onModelChange, projects, currentProject, currentProjectId, memberId, onLogin }: Props) {
  const [open, setOpen] = useState<'model' | 'project' | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const list = useFetcher<typeof projectsLoader>();
  const ownPage = list.data?.memberId === memberId && Boolean(memberId);
  const items = ownPage ? list.data!.items : projects;
  const error = list.data?.error;
  const busy = list.state !== 'idle';
  const selectedModel = models.find(model => model.id === selectedModelId);
  const visibleProjects = currentProject && !items.some(project => project.id === currentProject.id) ? [currentProject, ...items] : items;
  useEffect(() => setOpen(null), [location.pathname, location.search]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(null); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      (open === 'model' ? modelTrigger : projectTrigger).current?.focus();
      setOpen(null);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  function toggle(kind: 'model' | 'project') {
    if (!memberId) { onLogin(); return; }
    setOpen(value => value === kind ? null : kind);
    if (kind === 'project' && open !== 'project') void list.load('/projects');
  }
  function selectProject(projectId?: string) {
    setOpen(null);
    projectTrigger.current?.focus();
    if (projectId !== currentProjectId) void navigate(projectId ? '/projects/' + projectId + '/chat' : '/chat');
  }
  return <div ref={root} className="flex min-w-0 items-center gap-2 sm:gap-4" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(null); }}>
    <div className="relative min-w-0">
      <button ref={modelTrigger} className="flex h-9 max-w-full items-center gap-2 rounded-md px-1 text-sm font-semibold whitespace-nowrap hover:text-muted" aria-expanded={open === 'model'} aria-controls={id + '-models'} onClick={() => toggle('model')}>
        <span className="flex min-w-0 flex-col items-start gap-0.5 leading-tight sm:flex-row sm:items-center sm:gap-2"><span>모델 선택</span>{selectedModel && <span className="max-w-36 truncate text-xs font-normal text-muted" title={selectedModel.label}>{selectedModel.label}</span>}</span>
        <ChevronDown size={14} className="shrink-0 text-muted"/>
      </button>
      {open === 'model' && <div id={id + '-models'} aria-label="모델 선택 목록" className="absolute top-full left-0 z-30 mt-2 w-64 max-w-[calc(100vw-40px)] rounded-xl border border-line bg-panel p-1.5 shadow-xl">
        {models.map(model => <button key={model.id} className={optionClass} aria-pressed={selectedModelId === model.id} onClick={() => { onModelChange(model.id); setOpen(null); modelTrigger.current?.focus(); }}><span className="min-w-0 flex-1"><span className="block">{model.label}</span>{model.description && <span className="mt-1 block text-xs text-muted">{model.description}</span>}</span>{selectedModelId === model.id && <Check size={16} className="shrink-0"/>}</button>)}
        {!models.length && <p className="px-3 py-2 text-xs font-normal text-muted">모델 정보를 불러오지 못했습니다.</p>}
      </div>}
    </div>
    <div className="relative shrink-0">
      <button ref={projectTrigger} className="flex h-9 items-center gap-2 rounded-md px-1 text-sm font-semibold whitespace-nowrap hover:text-muted" aria-expanded={open === 'project'} aria-controls={id + '-projects'} onClick={() => toggle('project')}>프로젝트<ChevronDown size={14} className="text-muted"/></button>
      {open === 'project' && <div id={id + '-projects'} aria-label="프로젝트 선택 목록" className="absolute top-full left-0 z-30 mt-2 w-64 max-w-[calc(100vw-40px)] rounded-xl border border-line bg-panel p-1.5 shadow-xl max-sm:-left-20">
        <button className={optionClass} aria-pressed={!currentProjectId} onClick={() => selectProject()}><span className="flex-1">프로젝트 없음</span>{!currentProjectId && <Check size={16}/>}</button>
        <div className="my-1 border-t border-line"/>
        <div className="max-h-64 overflow-y-auto">{visibleProjects.map(project => <button key={project.id} className={optionClass} aria-pressed={currentProjectId === project.id} onClick={() => selectProject(project.id)}><FolderOpen size={16} className="shrink-0 text-muted"/><span className="flex-1 truncate">{project.name}</span>{currentProjectId === project.id && <Check size={16} className="shrink-0"/>}</button>)}</div>
        {busy && <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs font-normal text-muted"><LoaderCircle size={13} className="spin"/>불러오는 중</p>}
        {error && <button className={optionClass + ' !text-xs text-muted'} onClick={() => void list.load('/projects')}>목록을 불러오지 못했습니다. 재시도</button>}
        {!busy && !error && !visibleProjects.length && <p className="px-3 py-2 text-xs font-normal text-muted">아직 프로젝트가 없습니다.</p>}
        {ownPage && (list.data!.cursor || list.data!.has_more) && <div className="flex justify-between px-3 py-2 text-xs text-muted">{list.data!.cursor && <button disabled={busy} onClick={() => void list.load('/projects')}>처음</button>}{list.data!.has_more && list.data!.after && <button className="ml-auto" disabled={busy} onClick={() => void list.load('/projects?after=' + encodeURIComponent(list.data!.after!))}>다음</button>}</div>}
        <div className="my-1 border-t border-line"/>
        <button className={optionClass} onClick={() => { setOpen(null); void navigate('/projects?new=1'); }}><Plus size={16}/><span>새 프로젝트</span></button>
      </div>}
    </div>
  </div>;
}
