import { invalidateProjectRouteCache, resetProjectRouteCache } from './project-route-cache';

export interface PublicConfig {
  supabase_url: string;
  supabase_publishable_key: string;
  chatkit_domain_key: string;
  dev_mode: boolean;
  dev_auth_token?: string;
  ai_ready: boolean;
  chat_models?: Array<{ id: string; label: string; description?: string }>;
  default_chat_model?: string;
  version?: string;
  google_auth_enabled?: boolean;
  attachments_enabled?: boolean;
  max_file_bytes?: number;

}
export interface Member { id: string; email: string; display_name?: string; role: string }
export interface Connection {
  id: string; provider: string; name: string; description: string;
  connected: boolean; enabled: boolean; configured: boolean;
  account?: string; status?: string; category?: string;
  account_count?: number; accounts?: ConnectionAccount[];
}
export interface ConnectionAccount {
  id: string; account: string; connected: boolean; enabled: boolean; status?: string;
}
export function isAccountProvider(provider: string) {
  return CATALOG.some(service => service.provider === provider && service.category === 'workspace');
}
export interface Job {
  id: string; title: string; status: string; created_at: string;
  updated_at: string; thread_id?: string; result?: unknown; error?: string;
}
export interface Material { id: string; name: string; created_at: string }
export interface MaterialsPage { items: Material[]; has_more: boolean }

export interface LocalRoot { id: string; name: string; enabled: boolean }
export interface Device { id: string; name: string; status: string; last_seen_at?: string; roots: LocalRoot[] }

// ChatKit owns chat requests and streaming; page data uses React Router loaders/actions.
export function createApi(memberId?: string) {
  const authenticatedFetch: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    if (memberId) headers.set('X-SalesOS-Member', memberId);
    const response = await fetch(input, { ...init, headers, credentials: 'same-origin' });
    const path = new URL(input instanceof Request ? input.url : String(input), 'https://salesos.invalid').pathname;
    if (response.status === 401 || response.status === 403) resetProjectRouteCache();
    if (response.ok && path === '/api/attachments/upload') invalidateProjectRouteCache('/materials');
    return response;
  };
  return { fetch: authenticatedFetch };
}
export type Api = ReturnType<typeof createApi>;

export const CATALOG: Connection[] = [
  { id: 'google_drive', provider: 'google_drive', name: 'Google Drive', description: '문서와 파일을 찾아 읽기', category: 'workspace', connected: false, enabled: false, configured: false },
  { id: 'gmail', provider: 'gmail', name: 'Gmail', description: '메일 검색과 대화 요약', category: 'workspace', connected: false, enabled: false, configured: false },
  { id: 'google_sheets', provider: 'google_sheets', name: 'Google Sheets', description: '미팅 일정과 업무 기록 관리', category: 'workspace', connected: false, enabled: false, configured: false },
  { id: 'google_chat', provider: 'google_chat', name: 'Google Chat', description: '연결한 채팅방의 업무 맥락 읽기', category: 'workspace', connected: false, enabled: false, configured: false },
  { id: 'google_calendar', provider: 'google_calendar', name: 'Google Calendar', description: '일정 확인과 새 일정 등록', category: 'workspace', connected: false, enabled: false, configured: false },
  { id: 'notion', provider: 'notion', name: 'Notion', description: '연락처와 업무 자료 정리', category: 'workspace', connected: false, enabled: false, configured: false },
  { id: 'line', provider: 'line', name: 'LINE', description: '모바일 대화와 업무 알림', category: 'personal', connected: false, enabled: false, configured: false },
  { id: 'local_files', provider: 'local_files', name: '내 컴퓨터', description: '선택한 폴더의 파일 읽기', category: 'personal', connected: false, enabled: false, configured: false },
];

export function messageOf(error: unknown) { return error instanceof Error ? error.message : '잠시 후 다시 시도해 주세요.'; }
export function dateLabel(value?: string) {
  if (!value) return '아직 연결되지 않음';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '시간 확인 불가' : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(date);
}
