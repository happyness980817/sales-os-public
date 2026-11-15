import { data, Link, useLoaderData, type LoaderFunctionArgs, type ClientLoaderFunctionArgs } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { BackendError, createBackend, routeError } from '~/common/server/backend.server';
import { Notice } from '~/common/components/ui';
import { useWorkspace } from '~/common/lib/workspace';
import { readProjectRouteCache, useProjectRouteCache } from '~/common/lib/project-route-cache';
import type { Project } from '~/common/lib/projects';
export { routeHeaders as headers } from '~/common/server/backend.server';
export { shouldRevalidateChatNavigation as shouldRevalidate } from '~/common/lib/chat-navigation';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const backend = createBackend(request);
  try {
    if (!await backend.hasSession()) return data({ project: null as Project | null, memberId: '', error: '' }, { headers: backend.headers });
    const { member_id: memberId, ...project } = await backend.request<Project & { member_id: string }>('/projects/' + encodeURIComponent(params.projectId || ''));
    return data({ project, memberId, error: '' }, { headers: backend.headers });
  } catch (error) {
    if (error instanceof BackendError && error.status === 404) throw new Response('프로젝트를 찾을 수 없습니다.', { status: 404, headers: backend.headers });
    return data({ project: null as Project | null, memberId: '', error: routeError(error) }, { headers: backend.headers });
  }
}
export function clientLoader({ request, serverLoader }: ClientLoaderFunctionArgs) {
  return readProjectRouteCache(request, () => serverLoader<typeof loader>());
}

export default function ProjectChatPage() {
  const loaded = useLoaderData<typeof loader>();
  const { project, memberId, error } = loaded;
  const { member } = useWorkspace();
  useProjectRouteCache(loaded, member?.id);
  if (project && member?.id !== memberId) return <div className="p-6"><Notice>로그인 상태를 확인하고 있습니다. 새로고침해 주세요.</Notice></div>;
  if (error) return <div className="p-6"><Notice error>{error}</Notice></div>;
  return <>
    {project && <div className="flex shrink-0 items-center border-b border-line px-6 py-3"><Link to={'/projects/' + project.id} className="inline-flex min-w-0 items-center gap-2 text-xs text-muted hover:text-white"><ArrowLeft size={14}/><span className="truncate">{project.name} 요약</span></Link></div>}
  </>;
}
