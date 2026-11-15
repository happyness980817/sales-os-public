import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRouter } from 'react-router';
import { createProjectRouteCache, projectRouteCacheKey, readProjectRouteCache } from '../../app/common/lib/project-route-cache.ts';
import { shouldRevalidateWorkspaceNavigation } from '../../app/common/lib/workspace-navigation.ts';

const data = (owner = 'employee-a', title = 'First') => ({ memberId: owner, error: '', project: { name: title } });
const signal = () => new AbortController().signal;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('project URLs retain pagination while ignoring presentation and ChatKit thread state', () => {
  assert.equal(projectRouteCacheKey('https://sales.test/projects?new=1&after=page-2'), '/projects?after=page-2');
  assert.equal(projectRouteCacheKey('/projects/prj_one/chat?thread=thr_one'), '/projects/prj_one/chat');
  assert.notEqual(projectRouteCacheKey('/projects?after=one'), projectRouteCacheKey('/projects?after=two'));
});

test('SSR never shares a route response between requests', async () => {
  assert.equal(typeof window, 'undefined');
  let calls = 0;
  const request = new Request('https://sales.test/projects');
  const first = await readProjectRouteCache(request, async () => { calls++; return data('employee-a'); });
  const second = await readProjectRouteCache(request, async () => { calls++; return data('employee-b'); });
  assert.equal(calls, 2);
  assert.equal(first.memberId, 'employee-a');
  assert.equal(second.memberId, 'employee-b');
});

test('authenticated revisits reuse data until expiry without extending TTL on remount', async () => {
  let time = 0, calls = 0;
  const cache = createProjectRouteCache(() => time, 100);
  cache.setOwner('employee-a');
  const load = async () => { calls++; return data(); };
  const first = await cache.read('/projects', load, signal());
  time = 80;
  cache.seed('/projects', first);
  assert.equal(await cache.read('/projects', load, signal()), first);
  assert.equal(calls, 1);
  time = 100;
  assert.notEqual(await cache.read('/projects', load, signal()), first);
  assert.equal(calls, 2);
});

test('changing account clears data and refuses mismatched or guest seeds', async () => {
  const cache = createProjectRouteCache();
  cache.setOwner('employee-a');
  cache.seed('/projects', data());
  cache.setOwner('employee-b');
  cache.seed('/projects', data('employee-a'));
  let calls = 0;
  assert.equal((await cache.read('/projects', async () => { calls++; return data('employee-b'); }, signal())).memberId, 'employee-b');
  assert.equal(calls, 1);
  cache.setOwner('');
  cache.seed('/projects', data('employee-b'));
  await cache.read('/projects', async () => { calls++; return { memberId: '', error: '' }; }, signal());
  await cache.read('/projects', async () => { calls++; return { memberId: '', error: '' }; }, signal());
  assert.equal(calls, 3);
});

test('mutations discard old responses even if a mounted component tries to seed them again', async () => {
  const cache = createProjectRouteCache();
  cache.setOwner('employee-a');
  const old = await cache.read('/projects', async () => data('employee-a', 'Before'), signal());
  cache.invalidate();
  cache.seed('/projects', old);
  const next = await cache.read('/projects', async () => data('employee-a', 'After'), signal());
  assert.equal(next.project.name, 'After');
});

test('an account switch during a pending request reloads with the current identity', async () => {
  const cache = createProjectRouteCache();
  cache.setOwner('employee-a');
  const old = deferred();
  let calls = 0;
  const load = () => ++calls === 1 ? old.promise : Promise.resolve(data('employee-b', 'Current'));
  const pending = cache.read('/projects', load, signal());
  cache.setOwner('employee-b');
  old.resolve(data('employee-a', 'Private A'));
  assert.equal((await pending).memberId, 'employee-b');
  assert.equal(calls, 2);
  assert.equal((await cache.read('/projects', async () => assert.fail('cached'), signal())).project.name, 'Current');
});

test('aborted and failed reads never populate the cache', async () => {
  const cache = createProjectRouteCache();
  cache.setOwner('employee-a');
  const stale = deferred(), controller = new AbortController();
  const pending = cache.read('/projects', () => stale.promise, controller.signal);
  controller.abort(); stale.resolve(data());
  await assert.rejects(pending, error => error.name === 'AbortError');
  let calls = 0;
  const error = async () => { calls++; return { memberId: 'employee-a', error: 'temporarily unavailable' }; };
  await cache.read('/projects', error, signal());
  await cache.read('/projects', error, signal());
  assert.equal(calls, 2);
});

test('cached pagination is bounded per tab', async () => {
  const cache = createProjectRouteCache(Date.now, 1000, 2);
  cache.setOwner('employee-a');
  for (let page = 1; page <= 3; page++) await cache.read('/projects?after=' + page, async () => data(), signal());
  let calls = 0;
  await cache.read('/projects?after=1', async () => { calls++; return data(); }, signal());
  assert.equal(calls, 1);
});

function ready(router) {
  if (router.state.initialized && router.state.navigation.state === 'idle') return Promise.resolve();
  return new Promise(resolve => { const off = router.subscribe(state => { if (state.initialized && state.navigation.state === 'idle') { off(); resolve(); } }); });
}

test('route revisits reuse project data while mutation and explicit refresh fetch new data', async () => {
  const cache = createProjectRouteCache();
  cache.setOwner('employee-a');
  let calls = 0, title = 'Before';
  const router = createMemoryRouter([{
    path: '/',
    shouldRevalidate: args => {
      const refresh = shouldRevalidateWorkspaceNavigation({ ...args, defaultShouldRevalidate: true });
      if (refresh) cache.invalidate();
      return refresh;
    },
    loader: () => ({ memberId: 'employee-a' }),
    children: [
      { path: 'chat' },
      { path: 'projects', id: 'projects', loader: ({ request }) => cache.read('/projects', async () => { calls++; return data('employee-a', title); }, request.signal), action: () => { title = 'After'; return { ok: true }; } },
    ],
  }], { initialEntries: ['/projects'] });
  try {
    await ready(router);
    await router.navigate('/chat'); await router.navigate('/projects');
    assert.equal(calls, 1);
    await router.navigate('/projects', { formMethod: 'post', formData: new FormData() });
    assert.equal(calls, 2);
    assert.equal(router.state.loaderData.projects.project.name, 'After');
    await router.revalidate();
    assert.equal(calls, 3);
  } finally { router.dispose(); }
});
