import { data, redirect } from 'react-router';
import { assertSameOrigin, BackendError, createBackend, routeError } from '~/common/server/backend.server';
import type { Project, ProjectList, ProjectOverview, ProjectThreads } from '~/common/lib/projects';

type Backend = ReturnType<typeof createBackend>;
const NAME_LIMIT = 100;

function projectId(value: string | undefined) {
  if (!value || !/^prj_[a-f0-9]{32}$/.test(value)) throw new BackendError('프로젝트를 찾을 수 없습니다.', 404);
  return value;
}
function pageQuery(request: Request) {
  const cursor = new URL(request.url).searchParams.get('after') || '';
  if (cursor.length > 200 || /[\x00-\x1f]/.test(cursor)) throw new BackendError('페이지 주소를 확인해 주세요.', 400);
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('after', cursor);
  return { cursor, query: params.toString() };
}
function failureStatus(error: unknown) { return error instanceof BackendError ? error.status : 503; }
function editableFields(form: FormData) {
  const name = String(form.get('name') || '').trim();
  if (!name || name.length > NAME_LIMIT) throw new BackendError('프로젝트 이름을 100자 이내로 입력해 주세요.', 400);
  return { name };
}
async function mutationHeaders(backend: Backend, form: FormData) {
  const memberId = String(form.get('member_id') || '');
  if (!memberId || !await backend.hasSession()) throw new BackendError('로그인한 뒤 다시 시도해 주세요.', 401);
  return { 'X-SalesOS-Member': memberId };
}

export async function loadProjects(request: Request, backend = createBackend(request)) {
  const empty = { items: [] as Project[], has_more: false, after: null as string | null, cursor: '', memberId: '', error: '' };
  try {
    const { cursor, query } = pageQuery(request);
    if (!await backend.hasSession()) return data({ ...empty, cursor }, { headers: backend.headers });
    const { member_id: memberId, ...result } = await backend.request<ProjectList>('/projects?' + query);
    return data({ ...result, cursor, memberId, error: '' }, { headers: backend.headers });
  } catch (error) { return data({ ...empty, error: routeError(error) }, { status: failureStatus(error), headers: backend.headers }); }
}

export async function createProject(request: Request, backend = createBackend(request)) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  try {
    const form = await request.formData();
    if (form.get('intent') !== 'create') throw new BackendError('요청을 확인해 주세요.', 400);
    const headers = await mutationHeaders(backend, form);
    const fields = editableFields(form);
    const project = await backend.request<Project>('/projects', { method: 'POST', headers, body: JSON.stringify(fields) });
    return redirect('/projects/' + projectId(project.id), { status: 303, headers: backend.headers });
  } catch (error) { return data({ error: routeError(error) }, { status: failureStatus(error), headers: backend.headers }); }
}

export async function loadProject(request: Request, id: string | undefined, backend = createBackend(request)) {
  let project: Project | null = null;
  let memberId = '';
  let cursor = '';
  let threads: ProjectThreads = { items: [], has_more: false, after: null };
  try {
    const selected = projectId(id);
    const page = pageQuery(request);
    cursor = page.cursor;
    if (!await backend.hasSession()) return data({ project, threads, memberId, cursor, error: '' }, { headers: backend.headers });
    const result = await backend.request<ProjectOverview>('/projects/' + selected + '/overview?' + page.query);
    project = result.project;
    threads = result.threads;
    memberId = result.member_id;
    return data({ project, threads, memberId, cursor, error: result.threads_error }, { headers: backend.headers });
  } catch (error) { return data({ project, threads, memberId, cursor, error: routeError(error) }, { status: failureStatus(error), headers: backend.headers }); }
}

export async function updateProject(request: Request, id: string | undefined, backend = createBackend(request)) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  try {
    const selected = projectId(id);
    const form = await request.formData();
    if (form.get('intent') !== 'save') throw new BackendError('요청을 확인해 주세요.', 400);
    const headers = await mutationHeaders(backend, form);
    const revision = String(form.get('revision') || '');
    if (!/^[1-9][0-9]{0,9}$/.test(revision)) throw new BackendError('프로젝트를 새로고침한 뒤 다시 저장해 주세요.', 400);
    const fields = editableFields(form);
    const project = await backend.request<Project>('/projects/' + selected, {
      method: 'PATCH', headers, body: JSON.stringify({ ...fields, revision: Number(revision) }),
    });
    return data({ project, error: '' }, { headers: backend.headers });
  } catch (error) { return data({ project: null, error: routeError(error) }, { status: failureStatus(error), headers: backend.headers }); }
}

export async function refreshProjectSummary(request: Request, id: string | undefined, backend = createBackend(request)) {
  assertSameOrigin(request);
  if (request.method !== 'POST') throw new Response('Method not allowed', { status: 405 });
  try {
    const selected = projectId(id);
    const form = await request.formData();
    const headers = await mutationHeaders(backend, form);
    const intent = String(form.get('intent') || '');
    if (intent && intent !== 'revise') throw new BackendError('요청을 확인해 주세요.', 400);
    let body: string | undefined;
    if (intent === 'revise') {
      const instruction = String(form.get('instruction') || '').trim();
      if (!instruction || instruction.length > 2000) throw new BackendError('수정 요청을 2000자 이내로 입력해 주세요.', 400);
      const revision = String(form.get('revision') || '');
      if (!/^[1-9][0-9]{0,9}$/.test(revision)) throw new BackendError('프로젝트를 새로고침한 뒤 다시 시도해 주세요.', 400);
      body = JSON.stringify({ instruction, revision: Number(revision) });
    }
    const project = await backend.request<Project>('/projects/' + selected + '/summary', { method: 'POST', headers, ...(body ? { body } : {}) });
    return data({ project, error: '' }, { headers: backend.headers });
  } catch (error) { return data({ project: null, error: routeError(error) }, { status: failureStatus(error), headers: backend.headers }); }
}
