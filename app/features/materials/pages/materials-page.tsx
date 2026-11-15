import { ArrowRight, Files, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import { data, Link, useLoaderData, useNavigation, useRevalidator, useSearchParams } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { Empty, Notice } from '~/common/components/ui';
import type { MaterialsPage as MaterialsResponse } from '~/common/lib/api';
import { useWorkspace } from '~/common/lib/workspace';
import { createBackend, routeError } from '~/common/server/backend.server';
export { routeHeaders as headers } from '~/common/server/backend.server';

const PAGE_SIZE = 50;
const uploadDate = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul',
});

export async function loader({ request }: LoaderFunctionArgs) {
  const backend = await createBackend(request);
  const requestedOffset = Number(new URL(request.url).searchParams.get('offset') || 0);
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 && requestedOffset <= 100000 ? requestedOffset : 0;
  const empty: MaterialsResponse = { items: [], has_more: false };
  try {
    if (!await backend.hasSession()) return data({ ...empty, offset, error: '' }, { headers: backend.headers });
    const result = await backend.request<MaterialsResponse>(`/materials?limit=${PAGE_SIZE}&offset=${offset}`);
    return data({ ...result, offset, error: '' }, { headers: backend.headers });
  } catch (error) {
    return data({ ...empty, offset, error: routeError(error) }, { headers: backend.headers });
  }
}

function uploadedOn(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '날짜 확인 불가' : uploadDate.format(date);
}

export default function MaterialsPage() {
  const { authenticated, onLogin } = useWorkspace();
  const { items, has_more: hasMore, offset, error } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const loading = revalidator.state !== 'idle' || navigation.state !== 'idle';
  function goToOffset(next: number) {
    const params = new URLSearchParams(searchParams);
    if (next > 0) params.set('offset', String(next));
    else params.delete('offset');
    setSearchParams(params, { preventScrollReset: true });
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div><div className="eyebrow">YOUR UPLOADS</div><h1>자료</h1><p>업로드한 파일을 최신순으로 확인하세요.</p></div>
        <button className="icon-button" aria-label="자료 새로고침" onClick={() => void revalidator.revalidate()} disabled={!authenticated || loading}>
          <RefreshCw size={18} className={loading ? 'spin' : ''}/>
        </button>
      </div>

      {authenticated && error && <Notice error action={<button className="text-button" onClick={() => void revalidator.revalidate()}>재시도</button>}>{error}</Notice>}
      {!authenticated ? (
        <Empty icon={<Files size={27}/>} title="내 자료를 확인하세요" action={<button className="button button-primary" onClick={onLogin}>로그인</button>}>로그인하면 직접 업로드한 파일을 볼 수 있습니다.</Empty>
      ) : items.length > 0 ? (
        <div aria-busy={loading}>
          <div className="overflow-hidden rounded-panel border border-line bg-panel">
            <table className="w-full table-fixed border-collapse text-left">
              <caption className="sr-only">내가 업로드한 파일 목록, 업로드 날짜 최신순</caption>
              <thead className="border-b border-line text-xs text-muted">
                <tr><th scope="col" className="px-5 py-4 font-medium max-nav:px-4">파일명</th><th scope="col" className="w-36 px-5 py-4 font-medium max-nav:w-32 max-nav:px-4">업로드 날짜</th></tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} className="border-b border-rule last:border-b-0">
                    <td className="px-5 py-[19px] max-nav:px-4">
                      <div className="flex min-w-0 items-center gap-3 max-nav:gap-2"><FileText size={18} className="shrink-0 text-muted" aria-hidden="true"/><span className="min-w-0 text-sm leading-6 wrap-anywhere max-nav:text-xs">{item.name}</span></div>
                    </td>
                    <td className="px-5 py-[19px] text-xs whitespace-nowrap text-muted max-nav:px-4 max-nav:text-[11px]"><time dateTime={item.created_at}>{uploadedOn(item.created_at)}</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sr-only" role="status">{loading ? '자료를 불러오는 중입니다.' : `파일 ${offset + 1}번부터 ${offset + items.length}번까지 표시했습니다.`}</p>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted" role="status"><LoaderCircle size={18} className="spin"/>자료를 불러오는 중</div>
      ) : !error ? (
        <Empty icon={<Files size={27}/>} title={offset ? '이 페이지에는 자료가 없습니다' : '아직 업로드한 자료가 없습니다'} action={<Link className="button button-secondary" to="/chat">대화로 이동<ArrowRight size={15}/></Link>}>대화에 첨부한 파일이 여기에 표시됩니다.</Empty>
      ) : null}
      {authenticated && (offset > 0 || hasMore) && <div className="mt-6 flex justify-center gap-3">
        {offset > 0 && <button className="button button-secondary compact" disabled={loading} onClick={() => goToOffset(Math.max(0, offset - PAGE_SIZE))}>이전</button>}
        {hasMore && offset < 100000 && <button className="button button-secondary compact" disabled={loading} onClick={() => goToOffset(Math.min(100000, offset + PAGE_SIZE))}>{loading && <LoaderCircle size={15} className="spin"/>}다음</button>}
      </div>}
    </section>
  );
}
