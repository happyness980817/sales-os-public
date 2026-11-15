import { useOutletContext } from 'react-router';
import type { Api, Connection, Member, PublicConfig } from './api';

export interface WorkspaceContext {
  api: Api;
  config: PublicConfig | null;
  authenticated: boolean;
  authLoading: boolean;
  authError: string;
  session: { user: { id: string; email?: string } } | null;
  signedIn: boolean;
  member: Member | null;
  items: Connection[];
  busy: string | null;
  loading: boolean;
  error: string;
  newChat: number;
  selectedModelId: string;
  historyOpen: number;
  onHistoryOpened: (requestId: number) => void;
  onLogin: () => void;
  onToggle: (connection: Connection) => void;
  onDetail: (connection: Connection) => void;
  onRefresh: () => void;
  enroll: (kind: 'pc' | 'line') => Promise<void>;
  signOut: () => Promise<void>;
}
export function useWorkspace() { return useOutletContext<WorkspaceContext>(); }
