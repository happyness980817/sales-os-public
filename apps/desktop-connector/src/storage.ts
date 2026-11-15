import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ConnectorState } from './types';
export interface Cipher { encrypt(value: string): Buffer; decrypt(value: Buffer): string }
export function initialState(): ConnectorState {
  return { version: 1, serverUrl: '', name: '내 업무 PC', deviceId: null, deviceToken: null, roots: [], paused: false, rootsDirty: false, startAtLogin: false, lastConnectedAt: null, pendingResult: null };
}
export function stateStorage(directory: string, cipher: Cipher) {
  mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'connection.enc');
  return {
    read(): ConnectorState {
      if (!existsSync(filename)) return initialState();
      const value = JSON.parse(cipher.decrypt(readFileSync(filename))) as ConnectorState;
      if (value.version !== 1 || !Array.isArray(value.roots) || value.roots.length > 10 || typeof value.name !== 'string' || typeof value.serverUrl !== 'string') throw new Error('저장된 연결 설정을 읽을 수 없습니다.');
      return value;
    },
    write(value: ConnectorState) {
      const bytes = cipher.encrypt(JSON.stringify(value));
      const temp = `${filename}.tmp`;
      writeFileSync(temp, bytes, { mode: 0o600 });
      renameSync(temp, filename);
    },
  };
}
