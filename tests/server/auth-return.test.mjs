import assert from 'node:assert/strict';
import test from 'node:test';
import { safeAuthReturn, saveAuthReturn, takeAuthReturn } from '../../app/common/server/auth-return.server.ts';
const project = '/projects/prj_' + 'a'.repeat(32);
test('login returns to app pages and preserves only a bounded chat thread', () => {
  assert.equal(safeAuthReturn(project), project);
  assert.equal(safeAuthReturn(project + '/chat?thread=thr_123&redirect=https://evil.test'), project + '/chat?thread=thr_123');
  assert.equal(safeAuthReturn('/connections/google_drive?code=secret'), '/connections/google_drive');
  for (const value of ['//evil.test', 'https://evil.test', '/oauth/consent?authorization_id=auth', '/api/private', '/projects/../api/me', '/projects/not-a-project']) assert.equal(safeAuthReturn(value), '/chat');
});
test('project return cookie is HttpOnly and consumed once', async () => {
  const headers = new Headers();
  await saveAuthReturn(headers, project);
  const cookie = headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/i);
  const responseHeaders = new Headers();
  assert.equal(await takeAuthReturn(new Request('https://sales.test/auth/callback', { headers: {cookie: cookie.split(';')[0]} }), responseHeaders), project);
  assert.match(responseHeaders.getSetCookie()[0], /Max-Age=0/);
});
