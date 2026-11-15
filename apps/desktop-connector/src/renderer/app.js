const api = window.salesosConnect;
const $ = id => document.getElementById(id);
let state;
let pending = false;
function error(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
async function run(action) {
  if (pending) return;
  pending = true; error('');
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
  try {
    const result = await action();
    if (!result?.ok) throw new Error(result?.error || '요청을 처리하지 못했습니다.');
    const current = await api.state(); if (current.ok) render(current.value);
  } catch (cause) { error(cause.message || '연결을 확인해 주세요.'); }
  finally { pending = false; buttons.forEach(button => button.disabled = false); }
}
function render(next) {
  state = next;
  $('connect-form').hidden = state.connected;
  $('connected-panel').hidden = !state.connected;
  $('notice').textContent = state.message;
  $('version').textContent = state.version;
  const labels = { disconnected: '연결 필요', connecting: '연결 중', ready: '연결됨', paused: '일시중지', working: '조회 중', offline: '연결 대기', error: '확인 필요' };
  $('status-badge').textContent = labels[state.phase];
  $('status-badge').className = `badge ${state.phase === 'ready' || state.phase === 'working' ? 'ready' : ''}`;
  $('pause-toggle').setAttribute('aria-checked', String(!state.paused));
  $('login-toggle').setAttribute('aria-checked', String(state.startAtLogin));
  $('device-label').textContent = state.name;
  $('last-connected').textContent = state.lastConnectedAt ? `최근 연결 ${new Date(state.lastConnectedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '';
  $('folders').replaceChildren();
  if (!state.roots.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '아직 연결한 폴더가 없습니다.\n견적서나 업무 자료가 있는 폴더를 선택하세요.'; $('folders').append(empty);
  }
  for (const root of state.roots) {
    const row = document.createElement('div'); row.className = 'folder';
    const icon = document.createElement('span'); icon.className = 'folder-icon'; icon.textContent = '▱'; icon.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div'); info.className = 'folder-info';
    const name = document.createElement('div'); name.className = 'folder-name'; name.textContent = root.name;
    const location = document.createElement('div'); location.className = 'folder-path'; location.textContent = root.path; location.title = root.path;
    info.append(name, location);
    const remove = document.createElement('button'); remove.className = 'quiet muted'; remove.textContent = '해제'; remove.setAttribute('aria-label', `${root.name} 폴더 연결 해제`); remove.onclick = () => run(() => api.removeRoot(root.id));
    row.append(icon, info, remove); $('folders').append(row);
  }
}
$('connect-form').addEventListener('submit', event => { event.preventDefault(); void run(async () => { const result = await api.enroll({ serverUrl: $('server-url').value, name: $('device-name').value, code: $('connect-code').value }); if (result.ok) $('connect-code').value = ''; return result; }); });
$('add-folder').onclick = () => run(() => api.addRoot());
$('pause-toggle').onclick = () => run(() => api.pause(!state.paused));
$('login-toggle').onclick = () => run(() => api.loginStart(!state.startAtLogin));
$('disconnect').onclick = () => run(() => api.disconnect());
$('retry').onclick = () => run(() => api.retry());
$('quit').onclick = () => api.quit();
api.subscribe(render);
api.state().then(result => { if (result.ok) render(result.value); else error(result.error); }).catch(() => error('앱을 다시 실행해 주세요.'));
