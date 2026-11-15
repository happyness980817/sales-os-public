import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Mail, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import { Modal } from '~/common/components/ui';

export interface ProjectMember {
  id: string;
  display_name: string;
  email?: string;
  avatar_url?: string;
  role: 'owner' | 'member';
}

function memberName(member: ProjectMember) {
  return member.display_name.trim() || member.email || '멤버';
}

function initials(member: ProjectMember) {
  const name = memberName(member);
  if (/[가-힣]/.test(name)) return Array.from(name)[0];
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.slice(0, 2).map(word => Array.from(word)[0]).join('') : Array.from(name).slice(0, 2).join('')).toUpperCase();
}

function MemberAvatar({ member, size = 'sm' }: { member: ProjectMember; size?: 'sm' | 'md' }) {
  const [failedImage, setFailedImage] = useState<string | undefined>();
  return <span role="img" aria-label={memberName(member)} title={memberName(member)} className={'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-panel bg-zinc-800 font-medium text-zinc-200 ring-1 ring-white/5 ' + (size === 'md' ? 'size-10 text-xs' : 'size-8 text-[10px]')}>
    {member.avatar_url && member.avatar_url !== failedImage
      ? <img src={member.avatar_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailedImage(member.avatar_url)}/>
      : initials(member)}
  </span>;
}

export function MemberAvatars({ members, limit = 3, size = 'sm' }: { members: ProjectMember[]; limit?: number; size?: 'sm' | 'md' }) {
  const shown = members.slice(0, Math.max(1, limit));
  const remaining = members.length - shown.length;
  if (!members.length) return <span aria-label="멤버 정보 없음" className="inline-flex size-8 items-center justify-center rounded-full border border-line text-muted"><UsersRound size={14}/></span>;
  return <span role="group" aria-label={'프로젝트 멤버 ' + members.length + '명'} className="isolate inline-flex items-center -space-x-2">
    {shown.map(member => <MemberAvatar key={member.id} member={member} size={size}/>)}
    {remaining > 0 && <span title={members.slice(shown.length).map(memberName).join(', ')} aria-label={'다른 멤버 ' + remaining + '명'} className={'relative inline-flex shrink-0 items-center justify-center rounded-full border-2 border-panel bg-zinc-900 font-medium text-muted ring-1 ring-white/5 ' + (size === 'md' ? 'size-10 text-xs' : 'size-8 text-[10px]')}>+{remaining}</span>}
  </span>;
}

export function ProjectMembersDialog({ projectName, members, viewerId, canManage = false, onClose }: {
  projectName: string;
  members: ProjectMember[];
  viewerId?: string;
  canManage?: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'members' | 'invite'>('members');
  const [email, setEmail] = useState('');
  const [draftEmail, setDraftEmail] = useState('');
  const [error, setError] = useState('');
  const id = useId();
  const memberTab = useRef<HTMLButtonElement>(null);
  const inviteTab = useRef<HTMLButtonElement>(null);

  function switchTab(next: 'members' | 'invite') {
    setTab(next);
    setError('');
  }

  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!canManage || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'members' : event.key === 'End' ? 'invite' : tab === 'members' ? 'invite' : 'members';
    switchTab(next);
    (next === 'members' ? memberTab : inviteTab).current?.focus();
  }

  function previewInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) {
      setError('이메일 주소를 확인해 주세요.');
      return;
    }
    if (members.some(member => member.email?.toLowerCase() === address.toLowerCase())) {
      setError('이미 이 프로젝트에 참여 중인 멤버입니다.');
      return;
    }
    setDraftEmail(address);
  }

  return <Modal title="프로젝트 멤버" onClose={onClose}>
    <p className="mb-5 truncate text-sm text-muted" title={projectName}>{projectName}</p>
    <div role="tablist" aria-label="프로젝트 멤버 관리" className="mb-5 flex gap-5 border-b border-line">
      <button ref={memberTab} id={id + '-members-tab'} type="button" role="tab" aria-selected={tab === 'members'} aria-controls={id + '-members-panel'} tabIndex={tab === 'members' ? 0 : -1} onClick={() => switchTab('members')} onKeyDown={tabKey} className={'relative flex items-center gap-2 border-b-2 px-1 pb-3 text-sm outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-zinc-400 ' + (tab === 'members' ? 'border-white font-medium text-white' : 'border-transparent text-muted hover:text-white')}>멤버<span className="text-xs text-muted">{members.length}</span></button>
      {canManage && <button ref={inviteTab} id={id + '-invite-tab'} type="button" role="tab" aria-selected={tab === 'invite'} aria-controls={id + '-invite-panel'} tabIndex={tab === 'invite' ? 0 : -1} onClick={() => switchTab('invite')} onKeyDown={tabKey} className={'relative border-b-2 px-1 pb-3 text-sm outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-zinc-400 ' + (tab === 'invite' ? 'border-white font-medium text-white' : 'border-transparent text-muted hover:text-white')}>초대하기</button>}
    </div>
    {tab === 'members' ? <section id={id + '-members-panel'} role="tabpanel" aria-labelledby={id + '-members-tab'} tabIndex={0} className="outline-none focus-visible:ring-2 focus-visible:ring-zinc-400">
      <ul className="max-h-72 overflow-y-auto">
        {members.map(member => <li key={member.id} className="flex items-center gap-3 border-b border-line py-4 first:pt-0 last:border-0">
          <MemberAvatar member={member} size="md"/>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{memberName(member)}{member.id === viewerId && <span className="ml-1.5 text-xs font-normal text-muted">(나)</span>}</p>
            {member.email && <p className="mt-1 truncate text-xs text-muted" title={member.email}>{member.email}</p>}
          </div>
          <span className="shrink-0 rounded-md border border-line px-2 py-1 text-[11px] text-muted">{member.role === 'owner' ? '소유자' : '멤버'}</span>
          {canManage && member.role !== 'owner' && <button type="button" disabled aria-label={memberName(member) + ' 멤버 제외 — 준비 중'} title="멤버 관리 연결을 준비하고 있습니다." className="icon-button shrink-0"><UserMinus size={16}/></button>}
        </li>)}
      </ul>
      {!members.length && <p className="py-8 text-center text-sm text-muted">표시할 멤버가 없습니다.</p>}
      <div className="mt-5 border-t border-line pt-5">
        <p className="text-xs leading-5 text-muted">프로젝트 멤버는 이 프로젝트의 대화와 첨부 자료를 함께 볼 수 있습니다.</p>
        {canManage && <button type="button" onClick={() => switchTab('invite')} className="button button-primary mt-4 w-full"><UserPlus size={16}/>멤버 초대</button>}
      </div>
    </section> : <section id={id + '-invite-panel'} role="tabpanel" aria-labelledby={id + '-invite-tab'} tabIndex={0} className="outline-none focus-visible:ring-2 focus-visible:ring-zinc-400">
      {draftEmail ? <div>
        <div className="rounded-xl border border-line bg-black p-4">
          <p className="mb-3 text-xs text-muted">초대할 이메일</p>
          <p className="flex items-start gap-2.5 text-sm font-medium"><Mail size={16} className="mt-0.5 shrink-0 text-muted"/><span className="wrap-anywhere">{draftEmail}</span></p>
          <p className="mt-4 text-xs leading-5 text-muted">가입된 회원인지 확인하고, 이 프로젝트에 참여할 수 있는 초대 메일을 보내게 됩니다.</p>
        </div>
        <p role="status" className="mt-4 text-xs leading-5 text-muted">초대 기능을 준비하고 있습니다. 아직 계정 확인이나 메일 전송은 이루어지지 않았습니다.</p>
        <button type="button" className="button button-secondary mt-5 w-full" onClick={() => { setDraftEmail(''); setError(''); }}><ArrowLeft size={15}/>이메일 수정</button>
      </div> : <form onSubmit={previewInvite} noValidate className="space-y-4">
        <div>
          <label htmlFor={id + '-email'} className="mb-2 block text-sm font-medium">이메일</label>
          <input id={id + '-email'} type="email" autoComplete="off" inputMode="email" maxLength={254} value={email} onChange={event => { setEmail(event.target.value); setError(''); }} aria-invalid={Boolean(error)} aria-describedby={id + '-email-help' + (error ? ' ' + id + '-email-error' : '')} placeholder="name@company.com" className="h-11 w-full rounded-lg border border-line bg-black px-3 text-sm outline-none focus:border-zinc-400"/>
          <p id={id + '-email-help'} className="mt-2 text-xs leading-5 text-muted">SALES-OS에 가입한 회원의 이메일을 입력하세요.</p>
          {error && <p id={id + '-email-error'} role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
        </div>
        <button type="submit" disabled={!email.trim()} className="button button-primary w-full">초대 미리보기<ArrowRight size={16}/></button>
        <p className="text-xs leading-5 text-muted">초대 기능을 준비하고 있습니다. 아직 메일이 전송되지 않습니다.</p>
      </form>}
    </section>}
  </Modal>;
}
