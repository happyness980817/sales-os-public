import { FolderOpen } from 'lucide-react';
import { Link } from 'react-router';
import type { Project } from '~/common/lib/projects';
import { dateLabel } from '~/common/lib/api';
import { MemberAvatars, type ProjectMember } from './project-members';

function previewText(markdown: string) {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_~\x60]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

export function ProjectGalleryCard({ project, members, onMembers }: {
  project: Project;
  members: ProjectMember[];
  onMembers: () => void;
}) {
  const excerpt = previewText(project.overview);
  return <article className="group flex min-h-[288px] flex-col overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-zinc-600 focus-within:border-zinc-500">
    <Link to={'/projects/' + encodeURIComponent(project.id)} aria-label={project.name + ' 프로젝트 열기'}
      className="flex flex-1 flex-col p-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70">
      <div className="mb-5 flex items-start gap-3">
        <FolderOpen size={20} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true"/>
        <h2 className="line-clamp-2 text-base leading-6 font-semibold tracking-tight wrap-anywhere">{project.name}</h2>
      </div>
      {excerpt ? <p className="line-clamp-5 text-[13px] leading-6 whitespace-pre-line wrap-anywhere text-zinc-400">{excerpt}</p>
        : <p className="text-[13px] leading-6 text-zinc-500">대화를 시작하면 이곳에<br/>프로젝트 개요가 표시됩니다.</p>}
    </Link>
    <div className="flex min-h-[65px] items-center justify-between gap-3 border-t border-line px-5 py-3">
      <p className="min-w-0 text-[11px] leading-5 text-muted"><time dateTime={project.updated_at}>{dateLabel(project.updated_at)}</time><span className="block text-zinc-500">업데이트</span></p>
      <button type="button" onClick={onMembers} aria-label={project.name + ' 멤버 보기'}
        className="shrink-0 rounded-full p-1 outline-none transition-colors hover:bg-raised focus-visible:ring-2 focus-visible:ring-white/70">
        <MemberAvatars members={members}/>
      </button>
    </div>
  </article>;
}
