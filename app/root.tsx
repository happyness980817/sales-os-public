import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, Link } from 'react-router';
import type { Route } from './+types/root';
import './app.css';

export const links: Route.LinksFunction = () => [
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&display=swap' },
];
export const meta: Route.MetaFunction = () => [
  { title: 'SALES-OS' },
  { name: 'description', content: '내 자료와 연결하고, 대화로 업무를 이어가는 워크스페이스' },
  { name: 'theme-color', content: '#101010' },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="ko"><head><meta charSet="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><Meta/><Links/><script src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js" async/></head><body>{children}<ScrollRestoration/><Scripts/></body></html>;
}
export default function App() { return <Outlet/>; }
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return <main className="page"><div className="empty-state"><h1>{missing ? '페이지를 찾을 수 없습니다' : '화면을 불러오지 못했습니다'}</h1><p>{missing ? '주소를 확인하거나 대화로 돌아가 주세요.' : '잠시 후 다시 시도해 주세요.'}</p><Link className="button button-primary" to="/chat">대화로 돌아가기</Link></div></main>;
}
