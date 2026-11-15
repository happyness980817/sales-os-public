import { executeJob, fileByteLimit, limitResult } from './files';
import { ApiError, normalizeServerUrl, request } from './client';
import { initialState } from './storage';
import type { ConnectorState, DeviceJob, LocalRoot, PublicState } from './types';

type Storage = { read(): ConnectorState; write(state: ConnectorState): void };
type PublicPhase = PublicState['phase'];
export class Connector {
  state: ConnectorState;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private busy = false;
  private abort?: AbortController;
  private lastHeartbeat = 0;
  private failures = 0;
  private idleCount = 0;
  private phase: PublicPhase = 'disconnected';
  private message = '웹에서 연결 코드를 발급받아 이 PC를 연결하세요.';
  private activeFile?: string;
  constructor(private storage: Storage, private changed: () => void, private version: string) {
    this.state = storage.read();
    this.state.maxFileBytes = fileByteLimit(this.state.maxFileBytes);
    if (this.state.deviceId) { this.phase = this.state.paused ? 'paused' : 'connecting'; this.message = this.state.paused ? '파일 조회가 일시중지되어 있습니다.' : '서버 연결을 확인하고 있습니다.'; }
  }
  publicState(): PublicState {
    const { name, serverUrl, roots, paused, startAtLogin, lastConnectedAt } = this.state;
    return { connected: !!this.state.deviceId, name, serverUrl, roots, paused, startAtLogin, lastConnectedAt, phase: this.phase, message: this.message, activeFile: this.activeFile, version: this.version, maxFileBytes: fileByteLimit(this.state.maxFileBytes) };
  }
  private updateFileLimit(value: unknown) {
    const maximum = fileByteLimit(value, fileByteLimit(this.state.maxFileBytes));
    if (maximum !== this.state.maxFileBytes) { this.state.maxFileBytes = maximum; this.save(); }
  }
  private save() { this.storage.write(this.state); this.changed(); }
  private status(phase: PublicPhase, message: string) { this.phase = phase; this.message = message; this.changed(); }
  start() { this.stopped = false; this.schedule(0); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.abort?.abort(); }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delay);
  }
  async enroll(input: { serverUrl: string; name: string; code: string }) {
    if (this.state.deviceId) throw new Error('기존 연결을 해제한 뒤 새 계정에 연결해 주세요.');
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const name = input.name.trim();
    const code = input.code.trim();
    if (!name || name.length > 80 || !/^[A-Za-z0-9_-]{6,128}$/.test(code)) throw new Error('PC 이름과 연결 코드를 확인해 주세요.');
    this.status('connecting', 'PC를 연결하고 있습니다.');
    try {
      const data = await request<{ device_id: string; device_token: string; max_file_bytes?: number }>(serverUrl, '/api/device/enroll', 'POST', { code, name });
      if (typeof data.device_id !== 'string' || typeof data.device_token !== 'string' || !data.device_token) throw new Error('장치 연결 응답을 확인하지 못했습니다.');
      this.state = { ...initialState(), serverUrl, name, deviceId: data.device_id, deviceToken: data.device_token, maxFileBytes: fileByteLimit(data.max_file_bytes), startAtLogin: this.state.startAtLogin, rootsDirty: true };
      this.save(); this.status('ready', '연결되었습니다. 읽기를 허용할 폴더를 선택해 주세요.'); this.schedule(0);
    } catch (error) { this.status('error', error instanceof ApiError ? error.message : '서버에 연결하지 못했습니다. 주소와 네트워크를 확인해 주세요.'); throw error; }
  }
  async addRoot(root: LocalRoot) {
    if (!this.state.deviceId) throw new Error('먼저 이 PC를 SALES-OS에 연결해 주세요.');
    if (this.state.roots.length >= 10) throw new Error('폴더는 최대 10개까지 연결할 수 있습니다.');
    if (this.state.roots.some(item => item.path.toLowerCase() === root.path.toLowerCase())) throw new Error('이미 연결한 폴더입니다.');
    this.state.roots.push(root); this.state.rootsDirty = true; this.save(); this.schedule(0);
  }
  removeRoot(id: string) {
    this.state.roots = this.state.roots.filter(item => item.id !== id);
    if (this.state.pendingResult?.root_id === id) this.state.pendingResult = null;
    this.state.rootsDirty = true; this.abort?.abort(); this.save(); this.schedule(0);
  }
  pause(paused: boolean) {
    this.state.paused = paused; this.abort?.abort(); this.save();
    this.status(paused ? 'paused' : 'connecting', paused ? '파일 조회가 일시중지되어 있습니다.' : '서버 연결을 확인하고 있습니다.'); this.schedule(0);
  }
  setStartAtLogin(enabled: boolean) { this.state.startAtLogin = enabled; this.save(); }
  retry() { this.failures = 0; this.schedule(0); }
  async disconnect() {
    this.pause(true);
    if (this.state.deviceToken) {
      try { await request(this.state.serverUrl, '/api/device/disconnect', 'POST', {}, this.state.deviceToken); }
      catch (error) {
        if (!(error instanceof ApiError && [401, 403, 404].includes(error.status))) throw new Error('서버에서 해제를 확인하지 못했습니다. 조회는 중지되어 있습니다. 연결을 확인하고 다시 시도해 주세요.');
      }
    }
    const startAtLogin = this.state.startAtLogin;
    this.state = { ...initialState(), startAtLogin }; this.save(); this.status('disconnected', '이 PC의 연결을 해제했습니다.');
  }
  private async tick() {
    if (this.busy || this.stopped) { if (!this.stopped) this.schedule(1000); return; }
    if (!this.state.deviceToken || !this.state.deviceId || this.state.paused) { this.schedule(15_000); return; }
    this.busy = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let delay = 5000;
    const call = <T>(endpoint: string, method: string, body: unknown) => request<T>(this.state.serverUrl, endpoint, method, body, this.state.deviceToken!, signal);
    try {
      if (Date.now() - this.lastHeartbeat >= 30_000) {
        const heartbeat = await call<{ max_file_bytes?: number }>('/api/device/heartbeat', 'POST', { version: this.version });
        this.updateFileLimit(heartbeat.max_file_bytes);
        this.lastHeartbeat = Date.now(); this.state.lastConnectedAt = new Date().toISOString(); this.save();
      }
      if (this.state.rootsDirty) {
        const roots = this.state.roots.map(({ id, name, enabled }) => ({ id, name, enabled }));
        await call('/api/device/roots', 'PUT', { roots });
        // IPC may update roots while the request is in flight.
        if (JSON.stringify(roots) === JSON.stringify(this.state.roots.map(({ id, name, enabled }) => ({ id, name, enabled })))) this.state.rootsDirty = false;
        this.save();
      }
      if (this.state.rootsDirty || signal.aborted) return;
      if (this.state.pendingResult) {
        const pending = this.state.pendingResult;
        if (!this.state.roots.some(root => root.id === pending.root_id && root.enabled)) { this.state.pendingResult = null; this.save(); }
        else {
          const bounded = limitResult(pending.result, fileByteLimit(this.state.maxFileBytes));
          if (bounded !== pending.result) { pending.result = bounded; this.save(); }
          await call(`/api/device/jobs/${encodeURIComponent(pending.job_id)}/result`, 'POST', pending.result);
          this.state.pendingResult = null; this.save();
        }
      }
      const payload = await call<{ job: DeviceJob | null; max_file_bytes?: number }>('/api/device/jobs/claim', 'POST', {});
      this.updateFileLimit(payload.max_file_bytes);
      const job = payload.job;
      if (job) {
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(job.id) || typeof job.root_id !== 'string') throw new Error('서버 작업 형식을 확인할 수 없습니다.');
        this.idleCount = 0;
        const roots = this.state.roots.map(root => ({ ...root }));
        const selected = roots.find(root => root.id === job.root_id);
        this.activeFile = typeof job.path === 'string' ? job.path.slice(0, 150) : undefined;
        this.status('working', job.operation === 'read' ? '요청한 파일을 읽고 있습니다.' : '요청한 파일을 찾고 있습니다.');
        const result = await executeJob(roots, job, signal, fileByteLimit(this.state.maxFileBytes));
        if (signal.aborted || this.state.paused || !this.state.roots.some(root => root.id === selected?.id && root.path === selected?.path && root.enabled)) return;
        this.state.pendingResult = { job_id: job.id, root_id: job.root_id, result };
        this.save();
        await call(`/api/device/jobs/${encodeURIComponent(job.id)}/result`, 'POST', result);
        this.state.pendingResult = null; this.save();
        this.status('ready', result.ok ? '요청한 자료를 SALES-OS에 전달했습니다.' : result.error?.split(': ').slice(1).join(': ') || '파일을 읽지 못했습니다.');
        delay = 1000;
      } else {
        this.idleCount += 1;
        this.status('ready', this.state.roots.length ? '연결된 폴더의 파일 요청을 기다리고 있습니다.' : '읽기를 허용할 폴더를 선택해 주세요.');
        delay = Math.min(30_000, 3000 + this.idleCount * 1000);
      }
      this.failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      this.failures += 1;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        this.state.paused = true; this.save(); this.status('error', '장치 권한이 만료되었거나 해제되었습니다. 웹의 PC 연결 상태를 확인해 주세요.');
      } else if (error instanceof ApiError && error.status === 413 && this.state.pendingResult?.result.content_base64) {
        // A deployment limit can shrink between polling and upload. Discard the
        // oversized bytes and submit a small failure result instead of retrying forever.
        this.state.pendingResult.result = { ok: false, error: 'FILE_TOO_LARGE: 배포 서버의 전송 크기 제한을 초과했습니다.' };
        this.lastHeartbeat = 0; this.save(); this.status('ready', '서버의 파일 전송 한도를 확인하고 있습니다.');
      } else if (error instanceof ApiError && [404, 409, 410].includes(error.status) && this.state.pendingResult) {
        this.state.pendingResult = null; this.save(); this.status('ready', '만료되거나 취소된 파일 요청을 정리했습니다.');
      } else this.status('offline', error instanceof ApiError ? error.message : '서버 연결을 기다리고 있습니다. 잠시 후 자동으로 다시 시도합니다.');
      delay = Math.min(60_000, 5000 * 2 ** Math.min(this.failures, 4));
    } finally {
      this.activeFile = undefined; this.busy = false; this.changed(); this.schedule(delay);
    }
  }
}
