import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { messageOf, type Api, type PublicConfig, type Member } from '~/common/lib/api';
import { BrandMark } from '~/common/components/icons';
import { Notice } from '~/common/components/ui';
import { ChatKit, useChatKit } from '@openai/chatkit-react';
import { useFetcher, useLocation, useNavigate } from 'react-router';
import type { Project } from '~/common/lib/projects';
import { invalidateProjectRouteCache } from '~/common/lib/project-route-cache';
import { createChatReadCache } from './chat-read-cache';
export default function ChatPanel({ api, config, newChat, historyOpen, onHistoryOpened, authenticated, onLogin, project, member, selectedModelId, active = true }: { api: Api; config: PublicConfig | null; newChat: number; historyOpen: number; onHistoryOpened: (requestId: number) => void; authenticated: boolean; onLogin: () => void; project?: Project; member: Member | null; selectedModelId: string; active?: boolean }) {
  const navigate = useNavigate();
  const summary = useFetcher<{ project: Project | null; error: string }>();
  const location = useLocation();
  const selectedThread = new URLSearchParams(location.search).get('thread');
  const requestedThread = selectedThread && /^[a-zA-Z0-9_-]{1,120}$/.test(selectedThread) ? selectedThread : null;
  const activeThread = useRef(requestedThread);
  const initialThread = useRef(requestedThread);
  const handledNewChat = useRef(newChat);
  const handledHistory = useRef(0);
  const readCache = useMemo(() => createChatReadCache((input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (project) headers.set('X-SalesOS-Project', project.id);
    else headers.delete('X-SalesOS-Project');
    if (selectedModelId) headers.set('X-SalesOS-Model', selectedModelId);
    else headers.delete('X-SalesOS-Model');
    return api.fetch(input, { ...init, headers });
  }), [api, project?.id, selectedModelId]);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const { control, setThreadId, showHistory } = useChatKit({
    api: { url: '/api/chatkit', domainKey: config?.chatkit_domain_key || 'local-dev', fetch: readCache.fetch, ...(config?.attachments_enabled ? { uploadStrategy: { type: 'direct' as const, uploadUrl: '/api/attachments/upload' } } : {}) },
    initialThread: initialThread.current,
    locale: 'ko',
    frameTitle: 'SALES-OS 업무 대화',
    theme: { colorScheme: 'dark', color: { surface: { background: '#000000', foreground: '#0a0a0a' } } },
    startScreen: { greeting: project ? project.name + ' 프로젝트를 이어가세요' : '어떤 업무를 도와드릴까요?' },
    composer: { placeholder: '업무를 물어보거나 자료를 첨부하세요', ...(config?.attachments_enabled ? { attachments: { enabled: true, maxSize: config.max_file_bytes ?? 10 * 1024 * 1024, maxCount: 5, accept: {
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
      'text/csv': ['.csv'],
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    } } } : {}) },
    onResponseEnd: () => {
      readCache.clear();
      invalidateProjectRouteCache();
      if (project && member) void summary.submit({ member_id: member.id }, { method: 'post', action: '/projects/' + project.id + '/summary' });
    },
    onThreadChange: ({ threadId }) => {
      activeThread.current = threadId;
      if (!active) return;
      const params = new URLSearchParams(location.search);
      if (threadId) params.set('thread', threadId); else params.delete('thread');
      const search = params.toString();
      if ((search ? '?' + search : '') !== location.search) void navigate({ pathname: location.pathname, search }, { replace: true, preventScrollReset: true });
    },
    onReady: () => { setReady(true); setError(''); },
    onError: ({ error: chatError }) => { setError(chatError.message || '대화를 불러오지 못했습니다.'); },
  });
  useEffect(() => {
    if (!active || !ready || activeThread.current === requestedThread) return;
    activeThread.current = requestedThread;
    void setThreadId(requestedThread).catch(e => setError(messageOf(e)));
  }, [active, requestedThread, ready, setThreadId]);
  useEffect(() => {
    if (!active) { handledNewChat.current = newChat; return; }
    if (!ready || handledNewChat.current === newChat) return;
    handledNewChat.current = newChat;
    activeThread.current = null;
    void setThreadId(null).catch(e => setError(messageOf(e)));
  }, [active, newChat, ready, setThreadId]);
  useEffect(() => {
    if (!active || !historyOpen || !ready || handledHistory.current === historyOpen) return;
    handledHistory.current = historyOpen;
    void showHistory().catch(e => setError(messageOf(e))).finally(() => onHistoryOpened(historyOpen));
  }, [active, historyOpen, ready, showHistory, onHistoryOpened]);
  useEffect(() => {
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('salesos-session') : null;
    if (channel) channel.onmessage = () => readCache.clear();
    return () => channel?.close();
  }, [readCache]);
  if (!authenticated) return <div className="chat-welcome"><BrandMark/><h1>업무의 맥락을, 한곳에.</h1><p>내 자료와 연결하고, 대화로 일을 이어가세요.</p><button className="button button-primary" onClick={onLogin}>로그인하고 시작하기<ArrowRight size={17}/></button><button className="text-button welcome-link" onClick={() => navigate('/connections')}>연결할 수 있는 서비스 보기</button></div>;
  return <div className="chat-panel">
    {config && !config.ai_ready && <Notice>AI 연결을 준비하고 있습니다. 연결된 서비스와 이전 대화는 확인하실 수 있습니다.</Notice>}
    {error && <Notice error action={<button className="text-button" onClick={() => { setError(''); void setThreadId(null); }}>다시 열기</button>}>{error}</Notice>}
    {!ready && !error && <div className="chat-loading" role="status"><LoaderCircle size={18} className="spin"/>대화를 불러오고 있습니다</div>}
    <ChatKit control={control} className="chatkit" />
  </div>;
}
