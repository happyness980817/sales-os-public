import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { WorkspaceContext } from '~/common/lib/workspace';
import type { Project } from '~/common/lib/projects';
import ChatPanel from './chat-panel.client';

type Session = { id: string; project?: Project; used: number };

// Keep recent ChatKit elements attached while other pages are visible. This
// preserves the SDK's conversation, draft and scroll state without rebuilding it.
export function ChatHost({ context, active, project }: { context: WorkspaceContext; active: boolean; project?: Project }) {
  const [mounted, setMounted] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const currentId = project?.id || 'general';
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!active) return;
    setSessions(previous => {
      const existing = previous.find(item => item.id === currentId);
      if (existing) return previous.map(item => item.id === currentId ? { ...item, project, used: Date.now() } : item);
      const oldest = previous.reduce<Session | undefined>((found, item) => !found || item.used < found.used ? item : found, undefined);
      const retained = previous.length < 3 ? previous : previous.filter(item => item.id !== oldest?.id);
      return [...retained, { id: currentId, project, used: Date.now() }];
    });
  }, [active, currentId, project]);
  if (!mounted) return active ? <div className="chat-loading" role="status"><LoaderCircle size={18} className="spin"/>대화를 불러오고 있습니다</div> : null;
  return <div className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} aria-hidden={!active} inert={!active}>
    {sessions.map(session => {
      const visible = active && session.id === currentId;
      return <div key={session.id} className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'} aria-hidden={!visible} inert={!visible}>
        <ChatPanel {...context} project={visible ? project : session.project} active={visible}/>
      </div>;
    })}
  </div>;
}
