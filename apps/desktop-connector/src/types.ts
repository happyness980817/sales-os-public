export type LocalRoot = { id: string; name: string; path: string; enabled: boolean };
export type FileEntry = { name: string; relative_path: string; is_directory: boolean; size?: number; mtime?: string };
export type DeviceJob = { id: string; operation: 'list' | 'search' | 'read'; root_id: string; path?: string; query?: string; limit?: number; max_file_bytes?: number };
export type JobResult = {
  ok: boolean; files?: FileEntry[]; content_base64?: string; filename?: string;
  mime_type?: string; relative_path?: string; size?: number; mtime?: string;
  sha256?: string; truncated?: boolean; scanned?: number; error?: string;
};
export type PendingResult = { job_id: string; root_id: string; result: JobResult };
export type ConnectorState = {
  version: 1; serverUrl: string; name: string; deviceId: string | null; deviceToken: string | null;
  roots: LocalRoot[]; paused: boolean; rootsDirty: boolean; startAtLogin: boolean;
  lastConnectedAt: string | null; pendingResult: PendingResult | null; maxFileBytes?: number;
};
export type PublicState = {
  connected: boolean; name: string; serverUrl: string; roots: LocalRoot[];
  paused: boolean; startAtLogin: boolean; lastConnectedAt: string | null;
  phase: 'disconnected' | 'connecting' | 'ready' | 'paused' | 'working' | 'offline' | 'error';
  message: string; activeFile?: string; version: string; maxFileBytes: number;
};
