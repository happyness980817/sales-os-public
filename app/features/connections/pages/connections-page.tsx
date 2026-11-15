import { useState } from 'react';
import { ChevronRight, LoaderCircle, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { ServiceIcon } from '~/common/components/icons';
import { Notice, Empty } from '~/common/components/ui';
import { isAccountProvider } from '~/common/lib/api';
import { useWorkspace } from '~/common/lib/workspace';
export default function ConnectionsPage() {
  const { items, busy, loading, error, onToggle, onDetail, onRefresh } = useWorkspace();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'connected'>('all');
  const count = items.filter(c => c.connected).length;
  const filtered = items.filter(c => (filter === 'all' || c.connected) && `${c.name} ${c.description} ${c.account || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="page connections-page">
    <div className="page-heading"><div><div className="eyebrow">YOUR WORKSPACE</div><h1>서비스 연결</h1><p>익숙한 도구를 연결하고, 업무의 맥락을 이어가세요.</p></div><button className="icon-button" aria-label="연결 상태 새로고침" title="새로고침" onClick={onRefresh} disabled={loading}><RefreshCw size={18} className={loading ? 'spin' : ''}/></button></div>
    <div className="connection-controls"><div className="segmented" aria-label="서비스 필터"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>전체 <span>{items.length}</span></button><button className={filter === 'connected' ? 'selected' : ''} onClick={() => setFilter('connected')}>연결됨 <span>{count}</span></button></div><label className="search-field"><Search size={16}/><input aria-label="서비스 검색" placeholder="서비스 검색" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="clear-search" aria-label="검색 지우기" onClick={() => setQuery('')}><X size={14}/></button>}</label></div>
    {error && <Notice error>{error}</Notice>}
    {(['workspace', 'personal'] as const).map(group => {
      const rows = filtered.filter(c => group === 'personal' ? ['line', 'local_files'].includes(c.provider) : !['line', 'local_files'].includes(c.provider));
      if (!rows.length) return null;
      return <div className="connection-section" key={group}><div className="section-label"><h2>{group === 'workspace' ? '업무 서비스' : '기기 및 채널'}</h2><span>{group === 'workspace' ? '요청할 때 필요한 자료만 읽어요' : '어디서든 같은 업무를 이어가세요'}</span></div><div className="service-list">{rows.map(c => <div className="service-row" key={c.provider}>
        <button className="service-info" onClick={() => onDetail(c)}><ServiceIcon provider={c.provider}/><span className="service-copy"><span className="service-name">{c.name}{c.connected && <span className="connected-dot" aria-label="연결됨"/>}</span><span className="service-description">{c.account_count && c.account_count > 1 ? `계정 ${c.account_count}개 연결됨` : c.connected && c.account ? c.account : c.description}</span></span></button>
        {isAccountProvider(c.provider) ? <button className="icon-button" aria-label={`${c.name} 계정 관리`} onClick={() => onDetail(c)}><ChevronRight size={19}/></button> : <button type="button" role="switch" aria-checked={c.connected && c.enabled} aria-label={`${c.name} ${c.connected ? '사용' : '연결'}`} className={`toggle${c.connected && c.enabled ? ' is-on' : ''}`} onClick={() => onToggle(c)} disabled={busy === c.provider || loading}>{busy === c.provider ? <LoaderCircle size={13} className="spin"/> : <span/>}</button>}
      </div>)}</div></div>;
    })}
    {!filtered.length && <Empty icon={<Search size={25}/>} title={query ? '검색 결과가 없습니다' : '연결된 서비스가 없습니다'} action={<button className="button button-secondary" onClick={() => { setQuery(''); setFilter('all'); }}>전체 서비스 보기</button>}>{query ? '다른 서비스 이름으로 검색해 보세요.' : '사용할 서비스를 연결하면 여기에 표시됩니다.'}</Empty>}
    <div className="privacy-note"><ShieldCheck size={16}/><p>본인이 연결한 계정의 자료만 사용합니다.<br className="mobile-break"/> 연결은 언제든 해제할 수 있습니다.</p></div>
  </section>;
}
