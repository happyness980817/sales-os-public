import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { proxyApiRequest } from './api-proxy.server';
import { assertSameOrigin, BackendError, createBackend, routeError } from './backend.server';

// ChatKit and attachments still use their native HTTP/streaming protocol.
// Machine-to-machine LINE/PC credentials and OAuth callbacks retain their own authentication.
async function handle(request: Request) {
  const path = new URL(request.url).pathname;
  const employeePath = /^\/api\/(chatkit(?:$|\/)|attachments\/|me$|connections(?:$|\/)|materials$|projects(?:$|\/)|jobs(?:$|\/)|devices(?:$|\/)|device-enrollments$|local-files\/|line\/link-code$|settings\/)/.test(path)
    && !/^\/api\/connections\/[^/]+\/callback$/.test(path);
  if (!employeePath || request.headers.has('authorization')) return proxyApiRequest(request);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertSameOrigin(request);
  const backend = createBackend(request);
  let token: string | null;
  try { token = await backend.token(); }
  catch (error) {
    return Response.json({ detail: routeError(error) }, { status: error instanceof BackendError ? error.status : 503, headers: backend.headers });
  }
  const requestHeaders = new Headers(request.headers);
  if (token) requestHeaders.set('Authorization', 'Bearer ' + token);
  const response = await proxyApiRequest(new Request(request, { headers: requestHeaders }));
  const headers = new Headers(response.headers);
  for (const cookie of backend.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function loader({ request }: LoaderFunctionArgs) { return handle(request); }
export function action({ request }: ActionFunctionArgs) { return handle(request); }
