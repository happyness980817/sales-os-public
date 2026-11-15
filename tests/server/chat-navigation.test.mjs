import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRouter } from 'react-router';
import { shouldRevalidateChatNavigation } from '../../app/common/lib/chat-navigation.ts';

function ready(router) {
  if (router.state.initialized && router.state.navigation.state === 'idle') return Promise.resolve();
  return new Promise(resolve => {
    const unsubscribe = router.subscribe(state => {
      if (state.initialized && state.navigation.state === 'idle') { unsubscribe(); resolve(); }
    });
  });
}

function fixture(initialEntry) {
  const calls = { workspace: 0, project: 0, action: 0 };
  const router = createMemoryRouter([{
    id: 'workspace', path: '/', shouldRevalidate: shouldRevalidateChatNavigation,
    loader: () => { calls.workspace++; return {}; },
    children: [
      { id: 'chat', path: 'chat' },
      { id: 'project', path: 'projects/:projectId/chat', shouldRevalidate: shouldRevalidateChatNavigation,
        loader: () => { calls.project++; return {}; },
        action: () => { calls.action++; return { ok: true }; },
      },
    ],
  }], { initialEntries: [initialEntry] });
  return { router, calls };
}

test('ChatKit thread changes do not refetch authenticated workspace or project data', async () => {
  const { router, calls } = fixture('/projects/prj_one/chat');
  try {
    await ready(router);
    assert.deepEqual(calls, { workspace: 1, project: 1, action: 0 });
    for (const path of ['/projects/prj_one/chat?thread=thr_one', '/projects/prj_one/chat?thread=thr_two', '/projects/prj_one/chat']) {
      await router.navigate(path, { replace: true });
    }
    assert.deepEqual(calls, { workspace: 1, project: 1, action: 0 });
    await router.revalidate();
    assert.deepEqual(calls, { workspace: 2, project: 2, action: 0 }, 'explicit refresh must still verify the session and data');
  } finally { router.dispose(); }
});

test('project changes, other query state and mutations retain normal revalidation', async () => {
  const { router, calls } = fixture('/projects/prj_one/chat');
  try {
    await ready(router);
    await router.navigate('/projects/prj_two/chat');
    assert.equal(calls.project, 2, 'changing projects must load the newly selected project');
    await router.navigate('/projects/prj_two/chat?auth_error=expired');
    assert.equal(calls.workspace, 2, 'auth query state must not be ignored');
    assert.equal(calls.project, 3);
    await router.navigate('/projects/prj_two/chat?auth_error=expired&thread=thr_new', { formMethod: 'post', formData: new FormData() });
    assert.equal(calls.action, 1);
    assert.equal(calls.workspace, 3, 'a mutation with a thread URL still refreshes the workspace');
    assert.equal(calls.project, 4);
  } finally { router.dispose(); }
});
