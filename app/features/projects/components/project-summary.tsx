import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useFetcher, useRevalidator } from 'react-router';
import { Notice } from '~/common/components/ui';
import { dateLabel } from '~/common/lib/api';
import type { Project } from '~/common/lib/projects';
import type { action as summaryAction } from '../pages/project-summary-action';
import { ProjectMarkdown } from './project-markdown';

export function claimSummaryAttempt(status: Project['summary_status'], revision: number, hasThreads: boolean, attempted: Set<number>) {
  if (!hasThreads || !['empty', 'pending'].includes(status) || attempted.has(revision)) return false;
  attempted.add(revision);
  return true;
}

export function ProjectSummary({ project, memberId, hasThreads }: { project: Project; memberId: string; hasThreads: boolean }) {
  const summary = useFetcher<typeof summaryAction>();
  const edit = useFetcher<typeof summaryAction>();
  const revalidator = useRevalidator();
  const attempted = useRef(new Set<number>());
  const handledEdit = useRef<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saved, setSaved] = useState(false);
  const editBusy = edit.state !== 'idle';
  const busy = summary.state !== 'idle' || editBusy;
  const status = project.summary_status;
  const error = (!saved && summary.data?.error) || project.summary_error;
  const editError = edit.data?.error || edit.data?.project?.summary_error;
  const pending = busy || status === 'pending' && hasThreads;
  const actionPath = '/projects/' + encodeURIComponent(project.id) + '/summary';
  useEffect(() => {
    if (busy || editing || !claimSummaryAttempt(status, project.revision, hasThreads, attempted.current)) return;
    void summary.submit({ member_id: memberId }, { method: 'post', action: actionPath });
  }, [status, project.revision, hasThreads, memberId, actionPath, summary, busy, editing]);
  useEffect(() => {
    if (edit.state !== 'idle' || !edit.data || handledEdit.current === edit.data) return;
    handledEdit.current = edit.data;
    if (!edit.data.error && edit.data.project?.summary_status === 'ready') {
      setEditing(false); setInstruction(''); setSubmitted(false); setSaved(true);
    } else if (edit.data.error) {
      // Refresh a conflicting revision before retrying, while retaining the draft.
      void revalidator.revalidate();
    }
  }, [edit.state, edit.data, revalidator]);
  useEffect(() => {
    if (status !== 'pending' || !hasThreads || busy) return;
    const interval = setInterval(() => {
      if (!document.hidden && revalidator.state === 'idle') void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(interval);
  }, [status, hasThreads, busy, revalidator]);
  return <section aria-labelledby="project-summary-heading" className="rounded-xl border border-line bg-panel p-6 max-small:p-4">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 id="project-summary-heading" className="text-2xl font-semibold tracking-tight">프로젝트 요약</h2><button type="button" className="button button-secondary compact" disabled={busy} onClick={() => { setEditing(true); setSubmitted(false); setSaved(false); }}>요약 수정</button></div>
    {editing && <edit.Form method="post" action={actionPath} className="mb-5 space-y-3" onSubmit={() => { setSubmitted(true); setSaved(false); }}>
      <input type="hidden" name="member_id" value={memberId}/><input type="hidden" name="intent" value="revise"/><input type="hidden" name="revision" value={project.revision}/>
      <label htmlFor="project-summary-instruction" className="block text-sm font-medium">어떻게 수정할까요?</label>
      <textarea id="project-summary-instruction" name="instruction" value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="예: 다음 할 일을 먼저 보여주고, 완료한 작업은 짧게 정리해 주세요." rows={3} maxLength={2000} required autoFocus disabled={editBusy} className="w-full resize-y rounded-xl border border-line bg-black px-4 py-3 text-sm leading-6 outline-none focus:border-zinc-500"/>
      {submitted && !editBusy && editError && <Notice error>{editError}</Notice>}
      {submitted && !editBusy && !editError && edit.data?.project?.summary_status === 'pending' && <Notice>요약을 정리하고 있습니다. 잠시 후 다시 보내 주세요. 입력한 요청은 유지됩니다.</Notice>}
      <div className="flex justify-end gap-3"><button type="button" className="button button-secondary compact" disabled={editBusy} onClick={() => setEditing(false)}>취소</button><button className="button button-primary compact" disabled={busy || !instruction.trim()}>{editBusy && <LoaderCircle size={14} className="spin"/>}{editBusy ? '수정 중' : '보내기'}</button></div>
    </edit.Form>}
    {saved && !editing && <div className="mb-4"><Notice>요약을 수정했습니다.</Notice></div>}
    {pending && <p className="mb-4 flex items-center gap-2 text-sm text-muted" role="status"><LoaderCircle size={15} className="spin"/>{editBusy ? '에이전트가 요청에 맞춰 요약을 수정하고 있습니다.' : '에이전트가 대화를 정리하고 있습니다.'}</p>}
    {!busy && !editing && (status === 'failed' || error) && <div className="mb-4"><Notice error action={<summary.Form method="post" action={actionPath}><input type="hidden" name="member_id" value={memberId}/><button className="text-button" disabled={!hasThreads}>재시도</button></summary.Form>}>{error || '요약을 만들지 못했습니다. 다시 시도해 주세요.'}</Notice></div>}
    {project.overview.trim() ? <ProjectMarkdown>{project.overview}</ProjectMarkdown> : !pending && status !== 'failed' && !error ? <div className="py-8 text-center"><p className="text-sm leading-7 text-muted">{hasThreads ? '대화를 바탕으로 프로젝트 요약을 준비합니다.' : '대화를 시작하면 에이전트가 프로젝트를 요약합니다.'}</p></div> : null}
    {project.summary_updated_at && <p className="mt-5 text-xs text-muted"><time dateTime={project.summary_updated_at}>{dateLabel(project.summary_updated_at)}</time> 요약 업데이트</p>}
  </section>;
}
