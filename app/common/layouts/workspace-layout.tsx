import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronDown, CircleCheck, Clock3, Copy, ExternalLink, Files, FolderOpen, FolderKanban, History, Link2, LoaderCircle, Menu, MessageSquare, MoreHorizontal, Plus, Settings2, SquarePen, X } from 'lucide-react';
import { CATALOG, createApi, dateLabel, isAccountProvider, type Connection, type Member, type PublicConfig } from '~/common/lib/api';
import { BrandMark, ServiceIcon } from '~/common/components/icons';
import { Modal, Notice } from '~/common/components/ui';
import { data, Link, Outlet, useFetcher, useLoaderData, useLocation, useMatches, useNavigate, useRevalidator, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from 'react-router';
import type { WorkspaceContext } from '~/common/lib/workspace';
import type { Project } from '~/common/lib/projects';
import { createBackend, routeError } from '~/common/server/backend.server';
import type { action as connectionAction } from '~/features/connections/pages/connection-action';
import type { action as signInAction } from '~/features/auth/pages/sign-in';
import { ChatSelectors } from '~/features/chat/components/chat-selectors';
import { ChatHost } from '~/features/chat/components/chat-view';
import { shouldRevalidateWorkspaceNavigation } from '~/common/lib/workspace-navigation';
import { invalidateProjectRouteCache, resetProjectRouteCache, setProjectRouteCacheOwner } from '~/common/lib/project-route-cache';

export { routeHeaders as headers } from '~/common/server/backend.server';
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  const refresh = shouldRevalidateWorkspaceNavigation(args);
  if (refresh) invalidateProjectRouteCache();
  return refresh;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const backend = createBackend(request);
  let config: PublicConfig | null = null;
  let member: Member | null = null;
  let items: Connection[] = CATALOG;
  let projects: Project[] = [];
  let projectsError = '';
  let error = '';
  let configError = '';
  let signedIn = false;
  const failure = new URL(request.url).searchParams.get('auth_error');
  const authError = failure === 'cancelled' ? '로그인이 취소되었습니다. 다시 시도해 주세요.' : failure ? '로그인 링크가 만료되었거나 확인할 수 없습니다. 다시 로그인해 주세요.' : '';
  // Configuration can include external capability checks. Start private page
  // data as soon as the cookie session is available, independently of config.
  const [configuration, workspaceResult] = await Promise.allSettled([
    backend.request<PublicConfig>('/config'),
    (async () => {
      signedIn = !authError && await backend.hasSession();
      return signedIn ? backend.request<{ member: Member; items: Connection[]; projects: Project[]; projects_error: string }>('/workspace') : null;
    })(),
  ]);
  if (configuration.status === 'fulfilled') config = configuration.value;
  else configError = routeError(configuration.reason);
  if (!authError && config) {
    try {
      if (workspaceResult.status === 'rejected') throw workspaceResult.reason;
      const workspace = workspaceResult.value;
      if (workspace) {
        member = workspace.member;
        items = CATALOG.map(c => ({ ...c, ...workspace.items.find(row => row.provider === c.provider) }));
        projects = workspace.projects;
        projectsError = workspace.projects_error;
      }
    } catch (cause) { member = null; items = CATALOG; projects = []; error = routeError(cause); }
  }
  return data({ config, configError, member, items, projects, projectsError, error, authError, signedIn }, { headers: backend.headers });
}

type Page = 'chat' | 'projects' | 'connections' | 'jobs' | 'files' | 'materials' | 'settings';
const PAGE_TITLES: Record<Page, string> = { chat: '대화', projects: '워크스페이스', connections: '서비스 연결', jobs: '내 작업', files: '로컬', materials: '자료', settings: '설정' };

export default function WorkspaceLayout() {
  const loaded = useLoaderData<typeof loader>();
  const { revalidate, state } = useRevalidator();
  const refreshState = useRef({ state, lastRefreshedAt: 0 });
  const channelRef = useRef<BroadcastChannel | null>(null);
  refreshState.current.state = state;
  useEffect(() => { refreshState.current.lastRefreshedAt = Date.now(); }, [loaded]);
  useEffect(() => { setProjectRouteCacheOwner(loaded.member?.id || ''); }, [loaded.member?.id]);
  useEffect(() => {
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('salesos-session') : null;
    channelRef.current = channel;
    // Account changes must invalidate other tabs immediately, even during a load.
    if (channel) channel.onmessage = () => { resetProjectRouteCache(); void revalidate(); };
    const refresh = () => {
      if (document.hidden || refreshState.current.state !== 'idle' || Date.now() - refreshState.current.lastRefreshedAt < 60_000) return;
      refreshState.current.lastRefreshedAt = Date.now();
      void revalidate();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { channel?.close(); channelRef.current = null; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [revalidate]);
  useEffect(() => { channelRef.current?.postMessage('changed'); }, [loaded.member?.id]);
  // Remount private UI, ChatKit and fetchers when the authenticated employee changes.
  return <Workspace key={loaded.member?.id || 'guest'} loaded={loaded}/>;
}

function Workspace({ loaded }: { loaded: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const { config, configError, member, items, projects, projectsError, authError, signedIn } = loaded;
  const routeLocation = useLocation();
  const navigate = useNavigate();
  const lastGeneralChat = useRef('/chat');
  useEffect(() => { if (routeLocation.pathname === '/chat') lastGeneralChat.current = '/chat' + routeLocation.search; }, [routeLocation.pathname, routeLocation.search]);
  const revalidator = useRevalidator();
  const connection = useFetcher<typeof connectionAction>();
  const login = useFetcher<typeof signInAction>();
  const logout = useFetcher<{ error?: string }>();
  const api = useMemo(() => createApi(member?.id), [member?.id]);
  const authenticated = Boolean(member);
  const currentProjectId = /^\/projects\/(prj_[a-f0-9]{32})(?:\/|$)/.exec(routeLocation.pathname)?.[1];
  const matches = useMatches();
  const routeProject = matches.map(match => match.loaderData as { project?: Project; memberId?: string } | undefined).find(value => value?.project?.id === currentProjectId && value?.memberId === member?.id)?.project;
  const currentProject = routeProject || projects.find(project => project.id === currentProjectId);
  const [preferredModelId, setPreferredModelId] = useState('');
  const selectedModelId = config?.chat_models?.some(model => model.id === preferredModelId) ? preferredModelId : config?.default_chat_model || '';
  const chatPath = currentProjectId ? '/projects/' + currentProjectId + '/chat' : '/chat';
  const isChatPage = routeLocation.pathname === '/chat' || routeLocation.pathname.endsWith('/chat');
  const session = member ? { user: { id: member.id, email: member.email } } : null;
  const page = routeLocation.pathname.split('/')[1] as Page || 'chat';
  const loading = revalidator.state !== 'idle' || connection.state === 'loading';
  const busy = connection.state === 'idle' ? null : String(connection.formData?.get('provider') || '');
  const pairBusy = connection.state !== 'idle' && connection.formData?.get('intent') === 'enroll';
  const authLoading = false;
  const visibleItems = authenticated ? items : CATALOG;
  const error = loaded.error || connection.data?.error || logout.data?.error || '';
  const loginError = login.data?.error || '';
  const loginBusy = login.state !== 'idle';
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [loginOpen, setLoginOpen] = useState(Boolean(authError));
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [detail, setDetail] = useState<Connection | null>(null);
  const [pairing, setPairing] = useState<{ kind: 'pc' | 'line'; code: string; expires_at?: string; url?: string } | null>(null);
  const [newChat, setNewChat] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(0);
  const historySequence = useRef(0);
  const handled = useRef<unknown>(null);
  useEffect(() => setMobileOpen(false), [routeLocation.pathname]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (login.data?.emailSent) setEmailSent(true);
  }, [login.data]);
  useEffect(() => {
    if (connection.state !== 'idle' || !connection.data || handled.current === connection.data) return;
    handled.current = connection.data;
    if (connection.data.error) { setToast(connection.data.error); return; }
    setDetail(null);
    if (connection.data.pairing) setPairing(connection.data.pairing as NonNullable<typeof pairing>);
    if (connection.data.message) setToast(connection.data.message);
  }, [connection.state, connection.data]);
  function refresh() { return revalidator.revalidate(); }
  const loadConfig = refresh;
  function onLogin() { setLoginOpen(true); setEmailSent(false); }
  function submitConnection(values: Record<string, string>) {
    void connection.submit({ ...values, member_id: member?.id || '', requestId: crypto.randomUUID() }, { method: 'post', action: '/connections/manage' });
  }
  async function enroll(kind: 'pc' | 'line') {
    if (!authenticated) { onLogin(); return; }
    submitConnection({ intent: 'enroll', kind });
  }
  async function startConnection(c: Connection) {
    if (!authenticated) { setDetail(null); onLogin(); return; }
    if (c.provider === 'local_files') { await enroll('pc'); return; }
    if (c.provider === 'line') { await enroll('line'); return; }
    submitConnection({ intent: 'connect', provider: c.provider });
  }
  function showConnection(c: Connection) {
    if (isAccountProvider(c.provider)) navigate('/connections/' + encodeURIComponent(c.provider));
    else setDetail(c);
  }
  function toggle(c: Connection) {
    if (isAccountProvider(c.provider)) { showConnection(c); return; }
    if (!c.connected) { setDetail(c); return; }
    submitConnection({ intent: 'toggle', provider: c.provider, enabled: String(!c.enabled) });
  }
  function disconnect(c: Connection) { submitConnection({ intent: 'disconnect', provider: c.provider }); }
  function googleLogin() { void login.submit({ provider: 'google', return_to: routeLocation.pathname + routeLocation.search }, { method: 'post', action: '/auth/sign-in' }); }
  function emailLogin(event: FormEvent) {
    event.preventDefault();
    void login.submit({ email: email.trim(), return_to: routeLocation.pathname + routeLocation.search }, { method: 'post', action: '/auth/sign-in' });
  }
  async function signOut() { resetProjectRouteCache(); await logout.submit({}, { method: 'post', action: '/auth/sign-out' }); }
  function newConversation() { navigate(chatPath); setNewChat(value => value + 1); }
  const navItems: Array<{ page: Page; label: string; icon: ReactNode }> = [{ page: 'chat', label: '대화', icon: <MessageSquare/> }, { page: 'projects', label: '워크스페이스', icon: <FolderKanban/> }, { page: 'connections', label: '서비스 연결', icon: <Link2/> }, { page: 'jobs', label: '내 작업', icon: <Clock3/> }, { page: 'files', label: '로컬', icon: <FolderOpen/> }, { page: 'materials', label: '자료', icon: <Files/> }];
  const workspaceContext = { api, config, authenticated, authLoading: authLoading || !config && !configError, authError: authError || configError, session, signedIn, member, items: visibleItems, busy, loading, error, newChat, selectedModelId, historyOpen, onHistoryOpened: (requestId: number) => setHistoryOpen(value => value === requestId ? 0 : value), onLogin, onToggle: (c: Connection) => void toggle(c), onDetail: showConnection, onRefresh: () => void refresh(), enroll, signOut } satisfies WorkspaceContext;
  return <div className="flex min-h-dvh">
    {mobileOpen && <button className="sidebar-backdrop" aria-label="메뉴 닫기" onClick={() => setMobileOpen(false)}/>}
    <aside className={`sidebar${mobileOpen ? ' is-open' : ''}`}>
      <Link to="/chat" className="brand shrink-0" aria-label="SALES-OS 홈"><BrandMark/><span>SALES<span className="brand-os">OS</span></span></Link>
      <button className="button new-chat shrink-0" onClick={newConversation}><SquarePen size={19}/><span>새 대화</span><Plus size={17}/></button>
      <div className="min-h-0 flex-1 overflow-y-auto pb-5">
        <nav aria-label="주 메뉴" className="flex flex-col gap-[5px]">{navItems.map(n => <Link key={n.page} to={n.page === 'chat' ? lastGeneralChat.current : `/${n.page}`} className={`nav-item${page === n.page ? ' active' : ''}`} aria-current={page === n.page ? 'page' : undefined}>{n.icon}<span>{n.label}</span>{n.page === 'connections' && visibleItems.some(c => c.connected) && <span className="nav-count">{visibleItems.filter(c => c.connected).length}</span>}</Link>)}</nav>
        {authenticated && <div className="mt-5" aria-label="프로젝트 바로가기">
          <div className="mb-2 flex items-center justify-between px-4 text-[11px] text-muted"><span>프로젝트</span><Link to="/projects?new=1" className="icon-button" aria-label="프로젝트 만들기"><Plus size={14}/></Link></div>
          {projects.map(project => <Link key={project.id} to={'/projects/' + project.id} className={'nav-item !h-9 !text-xs' + (currentProjectId === project.id ? ' active' : '')}><FolderOpen className="!size-4"/><span className="truncate">{project.name}</span></Link>)}
          {!projects.length && !projectsError && <Link to="/projects" className="block px-4 py-2 text-xs text-muted hover:text-white">첫 프로젝트 만들기</Link>}
          {projectsError && <button className="px-4 py-2 text-left text-xs text-muted" onClick={() => void refresh()}>프로젝트를 불러오지 못했습니다. 재시도</button>}
        </div>}
        <div className="sidebar-divider"/>
        <button className="nav-item history-button" onClick={() => { if (!isChatPage) navigate(chatPath); setHistoryOpen(++historySequence.current); }}><History/><span>{currentProjectId ? '프로젝트 대화 기록' : '대화 기록'}</span><ChevronDown size={14}/></button>
      </div>
      <Link to="/settings" className={`nav-item shrink-0${page === 'settings' ? ' active' : ''}`}><Settings2/><span>설정</span></Link>
      <button className="profile-button shrink-0" onClick={authenticated ? () => navigate('/settings') : onLogin}><span className="avatar">{member?.display_name?.slice(0, 1) || member?.email?.slice(0, 1).toUpperCase() || <BrandMark small/>}</span><span className="profile-copy"><strong>{member?.display_name || (member?.email ? member.email.split('@')[0] : '내 워크스페이스')}</strong><span>{member?.email || (config?.dev_mode ? '로컬 개발 환경' : '로그인하고 시작하세요')}</span></span><MoreHorizontal size={18}/></button>
    </aside>
    <main className={`main ${isChatPage ? 'main-chat' : ''}`}>
      <header className="topbar gap-3"><div className="topbar-title min-w-0"><button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={() => setMobileOpen(true)}><Menu size={21}/></button>{isChatPage ? <ChatSelectors models={config?.chat_models || []} selectedModelId={selectedModelId} onModelChange={setPreferredModelId} projects={projects} currentProject={currentProject} currentProjectId={currentProjectId} memberId={member?.id} onLogin={onLogin}/> : <span className="truncate">{currentProjectId ? currentProject?.name || '프로젝트' : PAGE_TITLES[page] || '로그인'}</span>}</div><div className="topbar-actions min-w-0">{config?.dev_mode && <span className="dev-label">개발 모드</span>}{authenticated ? <span className="workspace-label min-w-0" title={currentProject?.name || '프로젝트 없음'}><span className="shrink-0"/><span className="max-w-48 truncate">{currentProjectId ? currentProject?.name || '프로젝트' : '프로젝트 없음'}</span></span> : <button className="button button-primary compact" onClick={onLogin}>로그인</button>}</div></header>
      {configError && <div className="global-notice"><Notice error action={<button className="text-button" onClick={() => void loadConfig()}>재시도</button>}>{configError}</Notice></div>}
      {page !== 'connections' && routeLocation.pathname !== '/auth/callback' && error && <div className="global-notice"><Notice error>{error}</Notice></div>}
      <Outlet key={authenticated ? member!.id : 'guest'} context={workspaceContext}/>
      <ChatHost context={workspaceContext} active={isChatPage && (!currentProjectId || !!routeProject)} project={currentProjectId ? routeProject : undefined}/>
    </main>
    {toast && <div className="toast" role="status"><span>{toast}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setToast('')}><X size={15}/></button></div>}
    {loginOpen && <Modal title="SALES-OS 시작하기" onClose={() => setLoginOpen(false)}><p className="modal-description">내 계정으로 로그인하고 업무를 이어가세요.<br/>초대된 직원만 워크스페이스를 사용할 수 있습니다.</p>{signedIn && <p className="modal-description">{member?.email || "로그인된 계정"}<br/><button className="text-button" onClick={() => void signOut()}>이 계정에서 로그아웃</button></p>}{(loginError || authError) && <Notice error>{loginError || authError}</Notice>}{emailSent ? <div className="email-sent"><CircleCheck size={30}/><h3>메일을 확인해 주세요</h3><p>{email}로 로그인 링크를 보냈습니다.</p><button className="text-button" onClick={() => setEmailSent(false)}>다른 이메일 사용</button></div> : <><button className="button google-login" onClick={() => void googleLogin()} disabled={loginBusy || !config?.supabase_publishable_key}><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285f4" d="M21.6 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3v2.5h3.3c1.9-1.8 2.9-4.3 2.9-7.4Z"/><path fill="#34a853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.5a6.1 6.1 0 0 1-9-3.2H3v2.6A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3a10 10 0 0 0 0 9l3.4-2.6Z"/><path fill="#ea4335" d="M12 6a5.4 5.4 0 0 1 3.8 1.5l2.9-2.9A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9 5.5l3.4 2.6A6 6 0 0 1 12 6Z"/></svg>Google로 계속하기</button><div className="or-divider"><span>또는</span></div><form onSubmit={emailLogin} className="login-form"><label htmlFor="login-email">업무용 이메일</label><input id="login-email" type="email" required autoComplete="email" placeholder="name@company.com" value={email} onChange={e => setEmail(e.target.value)} disabled={loginBusy}/><button className="button button-primary" disabled={loginBusy || !config?.supabase_publishable_key}>{loginBusy ? <LoaderCircle className="spin" size={17}/> : '이메일로 로그인 링크 받기'}</button></form></>}</Modal>}
    {detail && <Modal title={`${detail.name} ${detail.connected ? '연결 관리' : '연결'}`} onClose={() => setDetail(null)}><div className="connection-detail-icon"><ServiceIcon provider={detail.provider}/></div><p className="modal-description">{detail.description}.<br/>{detail.connected ? `${detail.account || '연결된 계정'}의 자료를 사용하고 있습니다.` : '본인 계정을 연결하면 대화에서 필요한 자료를 활용할 수 있습니다.'}</p>{detail.provider === 'local_files' && <p className="muted">PC 연결 프로그램을 설치한 뒤, 읽기를 허용할 폴더를 선택하세요.</p>}{detail.provider === 'line' && <p className="muted">발급된 연결 코드를 LINE 비서에게 보내면 계정이 연결됩니다.</p>}<div className="modal-actions">{detail.connected ? <button className="button button-danger" disabled={busy === detail.provider} onClick={() => void disconnect(detail)}>연결 해제</button> : <button className="button button-primary" disabled={busy === detail.provider || pairBusy} onClick={() => void startConnection(detail)}>{busy === detail.provider || pairBusy ? <LoaderCircle size={17} className="spin"/> : <Link2 size={16}/>}연결하기</button>}<button className="button button-secondary" onClick={() => setDetail(null)}>닫기</button></div></Modal>}
    {pairing && <Modal title={pairing.kind === 'pc' ? '내 PC 연결하기' : 'LINE 연결하기'} onClose={() => { setPairing(null); void refresh(); }}><p className="modal-description">{pairing.kind === 'pc' ? 'PC 연결 프로그램에 아래 코드를 입력해 주세요.' : 'LINE 비서에게 아래 메시지를 보내 주세요.'}</p><div className="pairing-code"><code>{pairing.kind === 'line' ? `연결 ${pairing.code}` : pairing.code}</code><button className="icon-button" aria-label="연결 코드 복사" onClick={() => { void navigator.clipboard.writeText(pairing.kind === 'line' ? `연결 ${pairing.code}` : pairing.code).then(() => setToast('연결 코드를 복사했습니다.')).catch(() => setToast('코드를 직접 선택해 복사해 주세요.')); }}><Copy size={18}/></button></div><p className="fine-print">한 번만 사용할 수 있는 코드입니다.{pairing.expires_at && ` ${dateLabel(pairing.expires_at)}까지 유효합니다.`}</p>{pairing.url && /^https:\/\/(line\.me|lin\.ee)\//.test(pairing.url) && <a className="button button-secondary full-width" href={pairing.url} target="_blank" rel="noreferrer">LINE 비서 열기<ExternalLink size={15}/></a>}<div className="modal-actions"><button className="button button-primary" onClick={() => { setPairing(null); void refresh(); if (pairing.kind === 'pc') navigate('/files'); }}>연결 상태 확인</button></div></Modal>}
  </div>;
}
