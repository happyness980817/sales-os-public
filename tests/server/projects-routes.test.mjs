import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';

const appRoot = new URL('../../app/', import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const base = specifier.startsWith('~/') ? new URL(specifier.slice(2), appRoot)
      : specifier.startsWith('.') && context.parentURL?.startsWith(appRoot.href) ? new URL(specifier, context.parentURL) : null;
    if (base && !/\.[cm]?[jt]sx?$/.test(base.pathname)) {
      for (const extension of ['.ts', '.tsx']) { const file = new URL(base.href + extension); if (existsSync(file)) return nextResolve(file.href, context); }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(appRoot.href) && url.endsWith('.tsx')) {
      return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText };
    }
    return nextLoad(url, context);
  },
});
const { loadProjects, loadProject, createProject, updateProject, refreshProjectSummary } = await import('../../app/features/projects/server/projects.server.ts');
const { BackendError } = await import('../../app/common/server/backend.server.ts');
const { ProjectMarkdown } = await import('../../app/features/projects/components/project-markdown.tsx');
const { claimSummaryAttempt, ProjectSummary } = await import('../../app/features/projects/components/project-summary.tsx');
const id = 'prj_' + 'a'.repeat(32);
const project = { id, name: '영업 프로젝트', overview: '# 목표\n이번 주 업무', created_at: '2026-11-15T00:00:00Z', updated_at: '2026-11-15T00:00:00Z', revision: 1, summary_status: 'ready', summary_updated_at: '2026-11-15T00:00:00Z', summary_error: null };
const get = path => new Request('https://sales.test' + path);
const post = (fields = {}, origin = 'https://sales.test') => new Request('https://sales.test/projects/' + id, { method: 'POST', headers: { origin }, body: new URLSearchParams({ member_id: 'employee-a', ...fields }) });
function mockBackend(respond, authenticated = true) {
  const calls = [];
  return { calls, backend: { headers: new Headers({ 'cache-control': 'private, no-store' }), hasSession: async () => authenticated,
    request: async (path, init = {}) => { calls.push({ path, init }); return respond(path, init); },
  } };
}

test('guest project loaders never request private project data', async () => {
  const mock = mockBackend(() => assert.fail('private request'), false);
  assert.deepEqual((await loadProjects(get('/projects'), mock.backend)).data.items, []);
  assert.equal((await loadProject(get('/projects/' + id), id, mock.backend)).data.project, null);
  assert.deepEqual(mock.calls, []);
});

test('project pagination uses one authenticated request and the member from that response', async () => {
  const mock = mockBackend((path, init) => {
    assert.equal(path, '/projects?limit=50&after=prj_previous');
    assert.equal(init.headers?.['X-SalesOS-Member'], undefined);
    return { items: [project], has_more: true, after: id, member_id: 'employee-a' };
  });
  const result = await loadProjects(get('/projects?after=prj_previous'), mock.backend);
  assert.equal(mock.calls.length, 1);
  assert.equal(result.data.cursor, 'prj_previous');
  assert.equal(result.data.after, id);
  assert.equal(result.data.memberId, 'employee-a');
  assert.equal(result.init.headers.get('cache-control'), 'private, no-store');
});

test('one project overview request scopes thread pagination to the selected project', async () => {
  const mock = mockBackend(() => ({ project, member_id: 'employee-a', threads_error: '', threads: { items: [{ id: 'thread-1', title: '첫 미팅', created_at: project.created_at }], has_more: false, after: null } }));
  const result = await loadProject(get('/projects/' + id + '?after=thread-previous'), id, mock.backend);
  assert.deepEqual(mock.calls.map(call => call.path), ['/projects/' + id + '/overview?limit=50&after=thread-previous']);
  assert.equal(result.data.project.id, id);
  assert.equal(result.data.threads.items[0].id, 'thread-1');
  assert.equal(result.data.memberId, 'employee-a');
  assert.equal(result.data.cursor, 'thread-previous');
});

test('project loaders keep the current request owner attached to its data across account changes', async () => {
  for (const owner of ['employee-a', 'employee-b']) {
    const ownedProject = { ...project, name: owner + ' private project' };
    const mock = mockBackend(path => path.startsWith('/projects?')
      ? { items: [ownedProject], has_more: false, after: null, member_id: owner }
      : { project: ownedProject, threads_error: '', threads: { items: [{ id: owner + '-thread' }], has_more: false, after: null }, member_id: owner });
    const list = await loadProjects(get('/projects'), mock.backend);
    const detail = await loadProject(get('/projects/' + id), id, mock.backend);
    assert.equal(list.data.memberId, owner);
    assert.equal(list.data.items[0].name, owner + ' private project');
    assert.equal(detail.data.memberId, owner);
    assert.equal(detail.data.project.name, owner + ' private project');
    assert.equal(detail.data.threads.items[0].id, owner + '-thread');
    assert.equal(mock.calls.length, 2);
  }
});

test('inaccessible projects and expired sessions never expose project or thread data', async () => {
  for (const status of [401, 403, 404]) {
    const mock = mockBackend(() => { throw new BackendError('프로젝트를 확인할 수 없습니다.', status); });
    const result = await loadProject(get('/projects/' + id), id, mock.backend);
    assert.equal(result.init.status, status);
    assert.equal(result.data.project, null);
    assert.equal(result.data.memberId, '');
    assert.deepEqual(result.data.threads.items, []);
    assert.equal(mock.calls.length, 1);
    const list = await loadProjects(get('/projects'), mock.backend);
    assert.equal(list.init.status, status);
    assert.equal(list.data.memberId, '');
    assert.deepEqual(list.data.items, []);
    assert.equal(mock.calls.length, 2);
  }
});

test('a thread-list failure preserves the project overview and displays its error', async () => {
  const error = '대화 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  const mock = mockBackend(() => ({ project, member_id: 'employee-a', threads: { items: [], has_more: false, after: null }, threads_error: error }));
  const result = await loadProject(get('/projects/' + id), id, mock.backend);
  assert.equal(result.data.project.overview, project.overview);
  assert.equal(result.data.memberId, 'employee-a');
  assert.equal(result.data.error, error);
  assert.deepEqual(result.data.threads.items, []);
  assert.equal(mock.calls.length, 1);
});

test('creating a project sends only its name and never accepts a user-written summary', async () => {
  const mock = mockBackend((path, init) => {
    assert.equal(path, '/projects'); assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { name: '새 프로젝트' });
    assert.equal(init.headers['X-SalesOS-Member'], 'employee-a');
    return project;
  });
  const result = await createProject(post({ intent: 'create', name: '  새 프로젝트  ', overview: '# 개요', owner_id: 'another-employee' }), mock.backend);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('location'), '/projects/' + id);
});

test('blank or overlong names and absent members cannot create a project', async () => {
  for (const fields of [
    { name: '   ', overview: '' }, { name: 'x'.repeat(101), overview: '' },
    { name: '프로젝트', member_id: '' },
  ]) {
    const mock = mockBackend(() => assert.fail('invalid mutation'));
    assert.ok((await createProject(post({ intent: 'create', ...fields }), mock.backend)).data.error);
    assert.equal(mock.calls.length, 0);
  }
});

test('renaming a project sends its revision without overwriting the agent summary', async () => {
  const mock = mockBackend((path, init) => {
    assert.equal(path, '/projects/' + id); assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(init.body), { name: '수정된 이름', revision: 7 });
    assert.equal(init.headers['X-SalesOS-Member'], 'employee-a');
    return { ...project, revision: 8, name: '수정된 이름' };
  });
  const result = await updateProject(post({ intent: 'save', name: '수정된 이름', overview: '- 다음 미팅', revision: '7' }), id, mock.backend);
  assert.equal(result.data.project.revision, 8);
  assert.equal(result.data.project.overview, project.overview);
  assert.equal(result.data.error, '');
});

test('revision conflicts stay visible and do not fabricate a successful save', async () => {
  const mock = mockBackend(() => { throw new BackendError('다른 곳에서 프로젝트가 수정되었습니다.', 409); });
  const result = await updateProject(post({ intent: 'save', name: '프로젝트', revision: '1' }), id, mock.backend);
  assert.equal(result.init.status, 409);
  assert.equal(result.data.project, null);
  assert.equal(result.data.error, '다른 곳에서 프로젝트가 수정되었습니다.');
});

test('malformed project paths and revisions fail before any mutation', async () => {
  for (const [selected, revision] of [['../another-project', '1'], [id, '0'], [id, '1.5'], [id, '']]) {
    const mock = mockBackend(() => assert.fail('invalid mutation'));
    assert.ok((await updateProject(post({ intent: 'save', name: '프로젝트', revision }), selected, mock.backend)).data.error);
    assert.equal(mock.calls.length, 0);
  }
});

test('cookie-backed project mutations reject cross-site requests', async () => {
  const mock = mockBackend(() => assert.fail('cross-site mutation'));
  await assert.rejects(createProject(post({ intent: 'create', name: '프로젝트' }, 'https://attacker.test'), mock.backend), error => error instanceof Response && error.status === 403);
  await assert.rejects(updateProject(post({ intent: 'save', name: '프로젝트', revision: '1' }, 'https://attacker.test'), id, mock.backend), error => error instanceof Response && error.status === 403);
});

test('summary refresh invokes only the selected project with an authenticated member and no body', async () => {
  const mock = mockBackend((path, init) => {
    assert.equal(path, '/projects/' + id + '/summary');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-SalesOS-Member'], 'employee-a');
    assert.equal(init.body, undefined);
    return { ...project, overview: '# 에이전트 요약', revision: 2 };
  });
  const result = await refreshProjectSummary(post({ overview: '사용자 입력으로 바꾸려는 내용', owner_id: 'other' }), id, mock.backend);
  assert.equal(result.data.project.overview, '# 에이전트 요약');
  assert.equal(result.data.error, '');
});

test('failed summary generation preserves the existing agent summary in the returned project', async () => {
  const mock = mockBackend(() => ({ ...project, summary_status: 'failed', summary_error: '잠시 후 다시 시도해 주세요.' }));
  const result = await refreshProjectSummary(post(), id, mock.backend);
  assert.equal(result.data.project.summary_status, 'failed');
  assert.equal(result.data.project.overview, project.overview);
});

test('summary requests reject cross-site, guest and missing member requests', async () => {
  const authenticated = mockBackend(() => assert.fail('unauthorized mutation'));
  await assert.rejects(refreshProjectSummary(post({}, 'https://attacker.test'), id, authenticated.backend), error => error instanceof Response && error.status === 403);
  assert.equal((await refreshProjectSummary(post({ member_id: '' }), id, authenticated.backend)).init.status, 401);
  const guest = mockBackend(() => assert.fail('guest mutation'), false);
  assert.equal((await refreshProjectSummary(post(), id, guest.backend)).init.status, 401);
});

test('automatic summary requests run once per pending revision and never retry failed or empty conversations', () => {
  const attempted = new Set();
  assert.equal(claimSummaryAttempt('empty', 1, false, attempted), false);
  assert.equal(claimSummaryAttempt('pending', 1, false, attempted), false);
  assert.equal(claimSummaryAttempt('empty', 1, true, attempted), true);
  assert.equal(claimSummaryAttempt('empty', 1, true, attempted), false);
  assert.equal(claimSummaryAttempt('pending', 2, true, attempted), true);
  assert.equal(claimSummaryAttempt('pending', 2, true, attempted), false);
  assert.equal(claimSummaryAttempt('failed', 3, true, attempted), false);
  assert.equal(claimSummaryAttempt('ready', 4, true, attempted), false);
  assert.deepEqual([...attempted], [1, 2]);
});

test('a legacy pending project with no conversations shows the start-conversation hint instead of a spinner', () => {
  const router = createMemoryRouter([{ path: '/', element: createElement(ProjectSummary, {
    project: { ...project, overview: '', summary_status: 'pending', summary_updated_at: null },
    memberId: 'employee-a', hasThreads: false,
  }) }]);
  try {
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    assert.ok(html.includes('대화를 시작하면 에이전트가 프로젝트를 요약합니다.'));
    assert.ok(!html.includes('에이전트가 대화를 정리하고 있습니다.'));
  } finally { router.dispose(); }
});

test('agent summary renders GFM headings, tables and tasks', () => {
  const html = renderToStaticMarkup(createElement(ProjectMarkdown, null, '# 목표\n\n- [x] 첫 미팅\n\n| 이름 | 상태 |\n| --- | --- |\n| A사 | 진행 |'));
  assert.match(html, /<h1>목표<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled/);
});

test('agent summary never executes raw HTML, dangerous links or remote images', () => {
  const source = '<script>alert(1)</script>\n\n<img src="https://tracking.invalid/pixel" onerror="alert(1)">\n\n[위험](javascript:alert(1))\n\n![자료](https://tracking.invalid/image)\n\n[안전한 링크](https://example.test)';
  const html = renderToStaticMarkup(createElement(ProjectMarkdown, null, source));
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('onerror='));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('src="https://tracking.invalid'));
  assert.match(html, /href="https:\/\/example.test"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('summary revision sends a trimmed instruction and revision without accepting replacement markdown', async () => {
  const mock = mockBackend((path, init) => {
    assert.equal(path, '/projects/' + id + '/summary');
    assert.equal(init.headers['X-SalesOS-Member'], 'employee-a');
    assert.deepEqual(JSON.parse(init.body), { instruction: '다음 할 일을 먼저 보여 주세요.', revision: 4 });
    return { ...project, overview: '# 다음 할 일', revision: 5 };
  });
  const result = await refreshProjectSummary(post({ intent: 'revise', instruction: '  다음 할 일을 먼저 보여 주세요.  ', revision: '4', overview: '직접 교체할 문서', owner_id: 'other' }), id, mock.backend);
  assert.equal(mock.calls.length, 1);
  assert.equal(result.data.project.overview, '# 다음 할 일');
  assert.equal(result.data.error, '');
});

test('summary revision rejects missing or oversized instructions and invalid revisions before calling AI', async () => {
  for (const fields of [
    { instruction: '' }, { instruction: '   ' }, { instruction: 'x'.repeat(2001) },
    { revision: '' }, { revision: '0' }, { revision: '1.5' }, { revision: 'abc' },
    { intent: 'replace' },
  ]) {
    const mock = mockBackend(() => assert.fail('invalid revision request'));
    const result = await refreshProjectSummary(post({ intent: 'revise', instruction: '짧게 정리해 주세요.', revision: '1', ...fields }), id, mock.backend);
    assert.equal(result.init.status, 400);
    assert.ok(result.data.error);
    assert.equal(mock.calls.length, 0);
  }
});

test('summary revision conflicts and generation failures do not report a successful replacement', async () => {
  const conflict = mockBackend(() => { throw new BackendError('요약이 변경되었습니다. 다시 시도해 주세요.', 409); });
  const result = await refreshProjectSummary(post({ intent: 'revise', instruction: '짧게 정리해 주세요.', revision: '1' }), id, conflict.backend);
  assert.equal(result.init.status, 409);
  assert.equal(result.data.project, null);
  assert.ok(result.data.error);
  const failure = mockBackend(() => ({ ...project, summary_status: 'failed', summary_error: '요약을 수정하지 못했습니다.' }));
  const failed = await refreshProjectSummary(post({ intent: 'revise', instruction: '짧게 정리해 주세요.', revision: '1' }), id, failure.backend);
  assert.equal(failed.data.project.summary_status, 'failed');
  assert.equal(failed.data.project.overview, project.overview);
});

test('project summary renders a large plain heading and an edit action without refresh or sparkle icons', () => {
  const router = createMemoryRouter([{ path: '/', element: createElement(ProjectSummary, { project, memberId: 'employee-a', hasThreads: false }) }]);
  try {
    const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
    assert.match(html, /<h2 id="project-summary-heading" class="text-2xl[^"]*">프로젝트 요약<\/h2>/);
    assert.match(html, /<button[^>]*>요약 수정<\/button>/);
    assert.ok(!html.includes('요약 새로고침'));
    assert.ok(!html.includes('lucide-sparkles'));
    assert.ok(!html.includes('lucide-refresh-cw'));
  } finally { router.dispose(); }
});
