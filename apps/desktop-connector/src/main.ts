import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, safeStorage, session, Tray } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Connector } from './connector';
import { createRoot, FileAccessError } from './files';
import { ApiError } from './client';
import { stateStorage } from './storage';

app.setName('SALES-OS Connect');
app.setPath('userData', path.join(app.getPath('appData'), 'SALES-OS-Connect'));
protocol.registerSchemesAsPrivileged([{ scheme: 'salesos-connect', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Squirrel installation lifecycle only. Remote jobs never execute commands.
const installEvent = process.argv.find(value => /^--squirrel-(install|updated|uninstall|obsolete)$/.test(value));
if (installEvent) {
  if (installEvent === '--squirrel-obsolete') app.quit();
  else {
    const updater = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
    const operation = installEvent === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut';
    const child = spawn(updater, [operation, path.basename(process.execPath)], { windowsHide: true, shell: false });
    child.on('close', () => app.quit()); child.on('error', () => app.quit());
  }
} else if (!app.requestSingleInstanceLock()) app.quit();
else void start();

async function start() {
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let connector: Connector | undefined;
  let quitting = false;
  app.on('second-instance', () => { window?.show(); if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('before-quit', () => { quitting = true; connector?.stop(); });
  app.on('window-all-closed', () => {});
  try {
    await app.whenReady();
    app.setAppUserModelId('com.squirrel.salesos_connect.salesos-connect');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 보안 저장소를 사용할 수 없어 PC 연결을 시작하지 못했습니다.');
    const assets = new Map([['/', ['index.html', 'text/html']], ['/app.css', ['app.css', 'text/css']], ['/app.js', ['app.js', 'text/javascript']]]);
    protocol.handle('salesos-connect', request => {
      const url = new URL(request.url); const asset = assets.get(url.pathname);
      if (request.method !== 'GET' || url.host !== 'app' || !asset) return new Response('Not found', { status: 404 });
      return new Response(readFileSync(path.join(__dirname, 'renderer', asset[0])), { headers: { 'Content-Type': asset[1], 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'" } });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('salesos-connect://app/') }));
    const changed = () => {
      if (!connector) return;
      const state = connector.publicState();
      if (window && !window.isDestroyed()) window.webContents.send('connector:state', state);
      if (tray) {
        tray.setToolTip(`SALES-OS Connect · ${state.paused ? '일시중지' : state.connected ? '연결됨' : '연결 필요'}`);
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: 'SALES-OS Connect 열기', click: () => window?.show() },
          { label: state.paused ? '파일 조회 재개' : '파일 조회 일시중지', enabled: state.connected, click: () => connector!.pause(!connector!.state.paused) },
          { type: 'separator' },
          { label: '종료', click: () => app.quit() },
        ]));
      }
    };
    const storage = stateStorage(app.getPath('userData'), { encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
    connector = new Connector(storage, changed, app.getVersion());
    window = new BrowserWindow({ width: 650, height: 760, minWidth: 480, minHeight: 560, title: 'SALES-OS Connect', backgroundColor: '#101010', show: false, autoHideMenuBar: true,
      icon: path.join(__dirname, 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('close', event => { if (!quitting) { event.preventDefault(); window!.hide(); } });
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 20, height: 20 }));
    tray.on('double-click', () => window?.show());
    let uiBusy = false;
    function handle(name: string, fn: (value: any) => unknown | Promise<unknown>) {
      ipcMain.handle(name, async (event, value) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window?.webContents.mainFrame || event.senderFrame?.url !== 'salesos-connect://app/') return { ok: false, error: '허용되지 않은 요청입니다.' };
        if (uiBusy) return { ok: false, error: '이전 작업이 끝난 후 다시 시도해 주세요.' };
        uiBusy = true;
        try { return { ok: true, value: await fn(value) }; }
        catch (error) {
          const message = error instanceof FileAccessError || error instanceof ApiError ? error.message : error instanceof Error && !(error as NodeJS.ErrnoException).code ? error.message : '작업을 처리하지 못했습니다. 설정을 확인해 주세요.';
          return { ok: false, error: message.slice(0, 300) };
        } finally { uiBusy = false; }
      });
    }
    handle('connector:get-state', () => connector!.publicState());
    handle('connector:enroll', value => {
      if (!value || ['serverUrl', 'name', 'code'].some(key => typeof value[key] !== 'string')) throw new Error('연결 정보를 확인해 주세요.');
      return connector!.enroll({ serverUrl: value.serverUrl, name: value.name, code: value.code });
    });
    handle('connector:add-root', async () => {
      if (!connector!.state.deviceId) throw new Error('먼저 PC를 연결해 주세요.');
      const selection = await dialog.showOpenDialog(window!, { title: '읽기를 허용할 업무 폴더 선택', buttonLabel: '이 폴더 연결', properties: ['openDirectory'] });
      if (!selection.canceled && selection.filePaths[0]) await connector!.addRoot(await createRoot(selection.filePaths[0]));
      return connector!.publicState();
    });
    handle('connector:remove-root', value => { if (typeof value !== 'string') throw new Error('폴더를 선택해 주세요.'); connector!.removeRoot(value); });
    handle('connector:pause', value => { if (typeof value !== 'boolean') throw new Error('설정을 확인해 주세요.'); connector!.pause(value); });
    handle('connector:login-start', value => {
      if (typeof value !== 'boolean') throw new Error('설정을 확인해 주세요.');
      if (value && !app.isPackaged) throw new Error('자동 실행은 설치된 앱에서 설정할 수 있습니다.');
      app.setLoginItemSettings({ openAtLogin: value, path: process.execPath, args: ['--start-hidden'] });
      connector!.setStartAtLogin(value);
    });
    handle('connector:disconnect', () => connector!.disconnect());
    handle('connector:retry', () => connector!.retry());
    handle('connector:quit', () => app.quit());
    await window.loadURL('salesos-connect://app/');
    if (!process.argv.includes('--start-hidden') || !connector.state.deviceId) window.show();
    changed(); connector.start();
  } catch (error) {
    dialog.showErrorBox('SALES-OS Connect를 시작하지 못했습니다', error instanceof Error ? error.message : '앱 설정을 확인해 주세요.');
    quitting = true; connector?.stop(); app.quit();
  }
}
