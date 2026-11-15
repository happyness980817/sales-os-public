import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRouter } from 'react-router';
import { shouldRevalidateWorkspaceNavigation } from '../../app/common/lib/workspace-navigation.ts';

const project = '/projects/prj_11111111111111111111111111111111';
function args(from, to, extra = {}) {
  return { currentUrl: new URL(from, 'https://sales.example'), nextUrl: new URL(to, 'https://sales.example'), currentParams: {}, nextParams: {}, defaultShouldRevalidate: true, ...extra };
}

test('framework navigation reuses connection and member data across workspace pages', () => {
  const paths = ['/chat', '/connections', '/connections/google_drive', '/projects', project, project + '/chat', '/jobs', '/files', '/materials', '/settings'];
  for (let index = 1; index < paths.length; index++) {
    assert.equal(shouldRevalidateWorkspaceNavigation(args(paths[index - 1], paths[index])), false);
  }
  for (const [from, to] of [['/chat', '/chat?thread=thr_one'], ['/projects', '/projects?new=1'], ['/projects?after=one', '/projects?after=two'], [project + '/chat?thread=thr_one', '/connections']]) {
    assert.equal(shouldRevalidateWorkspaceNavigation(args(from, to)), false);
  }
});

test('manual refresh, mutations, authentication and unknown routes still revalidate', () => {
  for (const [from, to] of [['/connections', '/connections'], ['/chat', '/chat?auth_error=expired'], ['/chat?auth_error=expired', '/chat'], ['/connections', '/connections?connected=google_drive'], ['/chat', '/chat?future=value'], ['/auth/callback', '/chat'], ['/chat', '/future-page']]) {
    assert.equal(shouldRevalidateWorkspaceNavigation(args(from, to)), true);
  }
  for (const extra of [{ formMethod: 'POST' }, { formAction: '/connections/manage' }, { actionResult: { ok: true } }, { actionStatus: 200 }]) {
    assert.equal(shouldRevalidateWorkspaceNavigation(args('/connections', '/chat', extra)), true);
  }
  assert.equal(shouldRevalidateWorkspaceNavigation(args('/connections', '/chat', { actionStatus: 400, defaultShouldRevalidate: false })), false);
});

function ready(router) {
  if (router.state.initialized && router.state.navigation.state === 'idle') return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = router.subscribe(state => {
      if (state.initialized && state.navigation.state === 'idle') { unsubscribe(); resolve(); }
    });
  });
}

test('returning to connections does not reload shared data, but a toggle and refresh do', async () => {
  let loads = 0, enabled = true;
  const router = createMemoryRouter([{
    id: 'workspace', path: '/',
    // Framework Single Fetch revalidates by default even on child navigation.
    shouldRevalidate: input => shouldRevalidateWorkspaceNavigation({ ...input, defaultShouldRevalidate: true }),
    loader: () => { loads++; return { member: 'employee-one', enabled }; },
    children: [
      { path: 'chat' },
      { path: 'connections', action: () => { enabled = !enabled; return { ok: true }; } },
      { path: 'projects', loader: () => ({ items: [] }) },
    ],
  }], { initialEntries: ['/connections'] });
  try {
    await ready(router);
    for (const path of ['/chat', '/projects', '/connections', '/chat', '/connections']) await router.navigate(path);
    assert.equal(loads, 1, 'five menu navigations must not recheck the same connected accounts');
    assert.equal(router.state.loaderData.workspace.enabled, true);
    await router.navigate('/connections', { formMethod: 'post', formData: new FormData() });
    assert.equal(loads, 2);
    assert.equal(router.state.loaderData.workspace.enabled, false, 'connection changes must update the displayed state');
    await router.revalidate();
    assert.equal(loads, 3, 'explicit refresh and cross-tab identity refresh must still load server state');
    await router.navigate('/chat?auth_error=expired');
    assert.equal(loads, 4);
  } finally { router.dispose(); }
});
