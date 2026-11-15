"""Internal API. Bind to 127.0.0.1; React Router proxies /api without changing SSE."""
import asyncio
import base64
import json
import re
import secrets
import time
from contextlib import asynccontextmanager
from urllib.parse import quote
import httpx
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Query, Body
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from chatkit.server import StreamingResult
from chatkit.store import NotFoundError
from chatkit.types import ImageAttachment, FileAttachment
from .config import Settings, settings as default_settings
from .repository import Repository, now
from .security import Security, digest, expires, is_expired
from .providers import Providers, CATALOG
from .devices import Devices
from .files import Files
from .tools import BusinessTools
from .chat import SalesChat, VerifiedProjectScope
from .line import LineBridge
from .projects import Projects, ProjectCreate, ProjectUpdate, ProjectSummary


class StrictBody(BaseModel):
    model_config = ConfigDict(extra='forbid')

class ConnectionBody(StrictBody):
    connection_id: str | None = Field(default=None, min_length=1, max_length=100)

class ToggleBody(StrictBody):
    enabled: bool

class EnrollBody(StrictBody):
    code: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=80)

class RootBody(StrictBody):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    enabled: bool = True

class RootsBody(StrictBody):
    roots: list[RootBody] = Field(max_length=20)

class LocalFileBody(StrictBody):
    device_id: str = Field(min_length=1, max_length=100)
    root_id: str = Field(min_length=1, max_length=100)
    query: str = Field(default='', max_length=300)
    path: str | None = Field(default=None, max_length=1000)
    thread_id: str | None = Field(default=None, max_length=100)

class ActionBody(StrictBody):
    action: str

class InviteBody(StrictBody):
    email: str = Field(min_length=3, max_length=254)

class SpacesBody(ConnectionBody):
    spaces: list[str] = Field(max_length=100)

class NotionContactsBody(StrictBody):
    page_id: str = Field(min_length=32, max_length=36)


def create_app(settings: Settings | None = None):
    settings = settings or default_settings
    repo = Repository(settings)
    security = Security(settings, repo)
    providers = Providers(settings, repo, security)
    files = Files(settings, repo)
    devices = Devices(repo, files)
    tools = BusinessTools(repo, providers, devices, files)
    chat = SalesChat(settings, repo, files, tools)
    projects = Projects(repo, settings)
    line = LineBridge(settings, repo, security, chat, providers)
    auth_settings_cache = {'checked_at': 0, 'google_auth_enabled': None}

    async def google_auth_status():
        if not settings.supabase_publishable_key:
            return False
        if time.monotonic() - auth_settings_cache['checked_at'] < 60:
            return auth_settings_cache['google_auth_enabled']
        try:
            response = await repo.http_client().get(settings.supabase_url + '/auth/v1/settings', timeout=5, headers={'apikey': settings.supabase_publishable_key})
            value = response.json().get('external', {}).get('google') if response.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            value = None
        auth_settings_cache.update(checked_at=time.monotonic(), google_auth_enabled=value)
        return value

    @asynccontextmanager
    async def lifespan(app):
        try:
            yield
        finally:
            await repo.close()

    app = FastAPI(title='SALES-OS internal API', version='0.1.0', lifespan=lifespan,
                  docs_url='/api/docs' if settings.dev_mode else None, redoc_url=None)
    app.state.repo, app.state.security, app.state.chat = repo, security, chat
    app.state.files, app.state.devices, app.state.line, app.state.providers = files, devices, line, providers
    app.state.projects = projects
    app.add_middleware(CORSMiddleware, allow_origins=[settings.public_url.rstrip('/')],
                       allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
                       allow_headers=['Authorization', 'Content-Type', 'X-SalesOS-Project', 'X-SalesOS-Member', 'X-SalesOS-Model'], allow_credentials=False)

    @app.middleware('http')
    async def limit_body(request, call_next):
        try:
            content_length = int(request.headers.get('content-length', '0'))
        except ValueError:
            return JSONResponse({'detail': '요청 크기가 올바르지 않습니다.'}, status_code=400)
        if content_length > 16 * 1024 * 1024:
            return JSONResponse({'detail': '요청 크기 제한을 초과했습니다.'}, status_code=413)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        if request.url.path != '/api/health': response.headers.setdefault('Cache-Control', 'no-store')
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, exc):
        # Do not echo tokens or arbitrary submitted document content in errors.
        return JSONResponse({'detail': '요청 항목을 확인해 주세요.'}, status_code=422)

    @app.exception_handler(NotFoundError)
    async def not_found(request, exc):
        return JSONResponse({'detail': '본인이 접근할 수 있는 대화나 자료가 아닙니다.'}, status_code=404)

    @app.exception_handler(httpx.HTTPError)
    async def upstream_error(request, exc):
        return JSONResponse({'detail': '외부 서비스 연결을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'}, status_code=503)

    async def owned_job(id, owner):
        row = await repo.get('jobs', id, owner)
        if not row: raise HTTPException(404, '작업을 찾을 수 없습니다.')
        return row

    async def public_job(row):
        data = dict(row['data'])
        data.pop('text', None); data.pop('event_id', None)
        result = data.get('result') or {}
        if result.get('file_id'):
            try: await files.read(row['owner_id'], result['file_id'])
            except HTTPException:
                data['result'] = {'file_id': result['file_id'], 'unavailable': True}
        return {'id': row['id'], **data}

    async def image_preview(owner, id):
        token = secrets.token_urlsafe(32)
        await repo.insert('file_previews', digest(token), owner, {'file_id': id, 'expires_at': expires(10)})
        return settings.public_url.rstrip('/') + f'/api/file-preview/{quote(id)}?token={token}'

    chat.store.image_preview = image_preview

    @app.get('/api/health')
    async def health():
        return {'ok': True, 'version': '0.1.0'}

    @app.get('/api/config')
    async def config(request: Request):
        local = security.local_dev(request) and repo.db is not None
        result = {'supabase_url': settings.supabase_url, 'supabase_publishable_key': settings.supabase_publishable_key,
                  'chatkit_domain_key': settings.chatkit_domain_key, 'chat_engine': 'chatkit',
                  'chat_models': settings.chat_models, 'default_chat_model': settings.openai_model, 'dev_mode': local, 'ai_ready': bool(settings.openai_api_key),
                  'attachments_enabled': True, 'max_file_bytes': settings.max_file_bytes, 'device_max_file_bytes': settings.device_file_limit, 'google_auth_enabled': await google_auth_status(), 'version': '0.1.0'}
        if local: result['dev_auth_token'] = settings.dev_token
        return result

    @app.get('/api/me')
    async def me(request: Request):
        member = await security.user(request)
        return {k: member[k] for k in ('id', 'email', 'display_name', 'role')}

    @app.get('/api/workspace')
    async def workspace(request: Request):
        member = await security.user(request)

        async def recent_projects():
            try:
                page = await projects.list(member['id'], 8)
                return page['items'], ''
            except HTTPException:
                return [], '프로젝트를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'

        items, (recent, projects_error) = await asyncio.gather(
            providers.connections(member['id']), recent_projects())
        return {'member': {k: member[k] for k in ('id', 'email', 'display_name', 'role')},
                'items': items, 'projects': recent, 'projects_error': projects_error}

    @app.get('/api/projects')
    async def list_projects(request: Request, limit: int = Query(default=50, ge=1, le=100), after: str | None = None):
        member = await security.user(request)
        page = await projects.list(member['id'], limit, after)
        return {**page, 'member_id': member['id']}

    @app.post('/api/projects', status_code=201)
    async def create_project(body: ProjectCreate, request: Request):
        member = await security.user(request)
        return await projects.create(member['id'], body)

    @app.get('/api/projects/{project_id}')
    async def get_project(project_id: str, request: Request):
        member = await security.user(request)
        return {**await projects.get(member['id'], project_id), 'member_id': member['id']}

    @app.get('/api/projects/{project_id}/overview')
    async def project_overview(project_id: str, request: Request, limit: int = Query(default=50, ge=1, le=100), after: str | None = None):
        member = await security.user(request)
        project = await projects.get(member['id'], project_id)
        threads = {'items': [], 'has_more': False, 'after': None}
        threads_error = ''
        try:
            context = {'member': member, 'project_id': project_id,
                       '_verified_project_scope': VerifiedProjectScope(member['id'], project_id)}
            page = await chat.store.load_threads(limit, after, 'desc', context)
            threads = {'items': [{'id': thread.id, 'title': thread.title, 'created_at': thread.created_at.isoformat()} for thread in page.data],
                       'has_more': page.has_more, 'after': page.after}
        except (HTTPException, NotFoundError) as exc:
            if isinstance(exc, HTTPException) and exc.status_code in (401, 403):
                raise
            # An owned overview remains useful while its conversation list is unavailable.
            threads_error = '프로젝트 대화를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
        return {'member_id': member['id'], 'project': project, 'threads': threads, 'threads_error': threads_error}

    @app.patch('/api/projects/{project_id}')
    async def update_project(project_id: str, body: ProjectUpdate, request: Request):
        member = await security.user(request)
        return await projects.update(member['id'], project_id, body)

    @app.post('/api/projects/{project_id}/summary')
    async def summarize_project(project_id: str, request: Request, body: ProjectSummary | None = None):
        member = await security.user(request)
        return await projects.summarize(member['id'], project_id, instruction=body.instruction if body else None,
                                        revision=body.revision if body else None)

    @app.get('/api/projects/{project_id}/threads')
    async def project_threads(project_id: str, request: Request, limit: int = Query(default=50, ge=1, le=100), after: str | None = None):
        member = await security.user(request)
        await projects.get(member['id'], project_id)
        page = await chat.store.load_threads(limit, after, 'desc', {'member': member, 'project_id': project_id})
        return {'items': [{'id': thread.id, 'title': thread.title, 'created_at': thread.created_at.isoformat()} for thread in page.data],
                'has_more': page.has_more, 'after': page.after}

    @app.post('/api/admin/invites')
    async def invite(body: InviteBody, request: Request):
        admin = await security.user(request)
        if admin['role'] != 'admin': raise HTTPException(403, '관리자만 직원을 등록할 수 있습니다.')
        email = body.email.strip().lower()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email): raise HTTPException(400, '이메일 주소를 확인해 주세요.')
        await repo.save('invitations', digest(email), admin['id'], {'email': email, 'active': True, 'created_at': now()})
        return {'email': email, 'registered': True, 'login_url': settings.public_url.rstrip('/') + '/chat', 'email_sent': False}

    @app.get('/api/connections')
    async def connections(request: Request):
        member = await security.user(request)
        return {'member_id': member['id'], 'items': await providers.connections(member['id'])}

    @app.post('/api/connections/{provider}/start')
    async def connect(provider: str, request: Request, body: ConnectionBody = Body(default=ConnectionBody())):
        member = await security.user(request)
        return {'url': await providers.start(member['id'], provider, body.connection_id)}

    @app.get('/api/connections/{provider}/accounts')
    async def connection_accounts(provider: str, request: Request):
        member = await security.user(request)
        return {'member_id': member['id'],
                'items': [{**item, 'id': item['connection_id']} for item in await providers.accounts(member['id'], provider)]}

    @app.patch('/api/connections/{provider}/accounts/{connection_id}')
    async def toggle_account(provider: str, connection_id: str, body: ToggleBody, request: Request):
        member = await security.user(request)
        await providers.toggle_account(member['id'], provider, connection_id, body.enabled)
        return {'ok': True, 'enabled': body.enabled}

    @app.delete('/api/connections/{provider}/accounts/{connection_id}')
    async def disconnect_account(provider: str, connection_id: str, request: Request):
        member = await security.user(request)
        await providers.disconnect(member['id'], provider, connection_id)
        return {'ok': True}

    @app.get('/api/connections/{kind}/callback')
    async def oauth_callback(kind: str, state: str = '', code: str = '', error: str = ''):
        if kind not in ('google', 'notion'): raise HTTPException(404, '연결 대상이 없습니다.')
        if error or not state or not code:
            return RedirectResponse(settings.public_url.rstrip('/') + '/connections?connection=cancelled', status_code=303)
        await providers.callback(kind, state, code)
        return RedirectResponse(settings.public_url.rstrip('/') + '/connections?connection=success', status_code=303)

    @app.patch('/api/connections/{provider}')
    async def toggle(provider: str, body: ToggleBody, request: Request):
        member = await security.user(request); owner = member['id']
        item = next((c for c in await providers.connections(owner) if c['id'] == provider), None)
        if not item: raise HTTPException(404, '연결 대상이 없습니다.')
        if not item['connected']: raise HTTPException(409, '먼저 계정이나 PC를 실제로 연결해 주세요.')
        if provider.startswith('google_') or provider == 'gmail':
            row = await providers.select_google(owner, provider, allow_disabled=True)
            await providers.toggle_account(owner, provider, row['data']['connection_id'], body.enabled)
            return {'ok': True, 'enabled': body.enabled}
        row = await repo.get('connections', f'{owner}:{provider}', owner)
        await repo.save('connections', f'{owner}:{provider}', owner, {**(row['data'] if row else {}),
                        'connected': True, 'enabled': body.enabled, 'updated_at': now()})
        return {'ok': True, 'enabled': body.enabled}

    @app.delete('/api/connections/{provider}')
    async def disconnect(provider: str, request: Request):
        member = await security.user(request); owner = member['id']
        if provider == 'line': return await line.disconnect(owner)
        if provider == 'local_files':
            for row in await repo.list('devices', owner):
                if not row['data'].get('revoked'): await devices.disconnect(row)
        await providers.disconnect(owner, provider)
        return {'ok': True}

    @app.get('/api/settings/google-chat')
    async def chat_settings(request: Request, connection_id: str | None = None):
        member = await security.user(request)
        args = {'connection_id': connection_id} if connection_id else {}
        result = await tools.call('list_chat_spaces', args, member['id'], '', '')
        if result.get('error'): raise HTTPException(result.get('status', 400), result['error'])
        return result

    @app.put('/api/settings/google-chat')
    async def save_chat_settings(body: SpacesBody, request: Request):
        member = await security.user(request)
        if any(not re.fullmatch(r'spaces/[A-Za-z0-9_-]+', s) for s in body.spaces): raise HTTPException(400, '올바른 채팅방 ID가 필요합니다.')
        # API also enforces access on each read; this list never grants upstream rights.
        connection = await providers.connection(member['id'], 'google_chat', body.connection_id)
        account_id = connection['data']['connection_id']
        await repo.save('settings', f"{member['id']}:chat_spaces:{account_id}", member['id'], {'spaces': list(dict.fromkeys(body.spaces))})
        return {'ok': True}

    @app.get('/api/settings/notion-contacts')
    async def notion_settings(request: Request):
        member = await security.user(request)
        row = await repo.get('settings', member['id'] + ':notion_contacts', member['id'])
        return row['data'] if row else {'page_id': None}

    @app.put('/api/settings/notion-contacts')
    async def save_notion_settings(body: NotionContactsBody, request: Request):
        member = await security.user(request)
        if not re.fullmatch(r'[0-9a-fA-F-]{32,36}', body.page_id): raise HTTPException(400, '올바른 Notion 페이지 ID가 필요합니다.')
        page = await providers.notion(member['id'], 'GET', 'pages/' + body.page_id)
        await repo.save('settings', member['id'] + ':notion_contacts', member['id'], {'page_id': page['id']})
        return {'ok': True}

    @app.get('/api/devices')
    async def list_devices(request: Request):
        member = await security.user(request)
        return {'member_id': member['id'], 'items': await devices.list(member['id'])}

    @app.post('/api/device-enrollments')
    async def enrollment(request: Request):
        member = await security.user(request)
        return await devices.enrollment(member['id'])

    @app.delete('/api/devices/{id}')
    async def revoke_device(id: str, request: Request):
        member = await security.user(request)
        row = await repo.get('devices', id, member['id'])
        if not row: raise HTTPException(404, 'PC를 찾을 수 없습니다.')
        return await devices.disconnect(row)

    @app.post('/api/device/enroll')
    async def enroll(body: EnrollBody):
        return await devices.enroll(body.code, body.name)

    @app.post('/api/device/heartbeat')
    async def heartbeat(request: Request):
        return await devices.heartbeat(await security.device(request))

    @app.put('/api/device/roots')
    async def roots(body: RootsBody, request: Request):
        return await devices.roots(await security.device(request), [r.model_dump() for r in body.roots])

    @app.post('/api/device/disconnect')
    async def device_disconnect(request: Request):
        return await devices.disconnect(await security.device(request))

    @app.post('/api/device/jobs/claim')
    async def claim_job(request: Request):
        return await devices.claim(await security.device(request))

    @app.post('/api/device/jobs/{id}/result')
    async def device_result(id: str, request: Request):
        device = await security.device(request)
        try: body = await request.json()
        except ValueError: raise HTTPException(400, '작업 결과 형식을 확인해 주세요.') from None
        if not isinstance(body, dict): raise HTTPException(400, '작업 결과 형식을 확인해 주세요.')
        return await devices.result(device, id, body)

    @app.post('/api/local-files/{operation}')
    async def local_file(operation: str, body: LocalFileBody, request: Request):
        member = await security.user(request); owner = member['id']
        if body.thread_id and not await repo.get('threads', body.thread_id, owner): raise HTTPException(404, '본인의 대화가 아닙니다.')
        if operation not in ('list', 'search', 'read'): raise HTTPException(404, '지원하는 파일 요청이 아닙니다.')
        connection = await repo.get('connections', f'{owner}:local_files', owner)
        if connection and not connection['data'].get('enabled', True): raise HTTPException(409, '내 PC 연결 사용을 켜 주세요.')
        return await devices.create_job(owner, body.device_id, body.root_id, operation, path=body.path, query=body.query, thread_id=body.thread_id)

    @app.get('/api/jobs')
    async def jobs(request: Request):
        member = await security.user(request)
        rows = await repo.list('jobs', member['id'], limit=100)
        slots = asyncio.Semaphore(6)

        async def checked_job(row):
            async with slots:
                return await public_job(row)

        return {'member_id': member['id'], 'items': await asyncio.gather(*(checked_job(row) for row in rows))}

    @app.get('/api/jobs/{id}')
    async def job(id: str, request: Request):
        member = await security.user(request)
        return await public_job(await owned_job(id, member['id']))

    @app.post('/api/jobs/{id}/actions')
    async def job_action(id: str, body: ActionBody, request: Request):
        member = await security.user(request)
        row = await owned_job(id, member['id']); data = row['data']
        if body.action != 'cancel': raise HTTPException(400, '지원하는 작업 동작이 아닙니다.')
        if data['status'] in ('succeeded', 'failed', 'cancelled', 'expired'): return await public_job(row)
        updated = {**data, 'cancel_requested_at': now(), 'updated_at': now()}
        if data.get('kind') != 'agent': updated['status'] = 'cancelled'
        row = await repo.cas(row, updated)
        if not row: raise HTTPException(409, '작업 상태가 변경되었습니다.')
        return await public_job(row)

    @app.get('/api/materials')
    async def materials(request: Request, limit: int = Query(default=50, ge=1, le=100),
                        offset: int = Query(default=0, ge=0, le=100000)):
        member = await security.user(request)
        rows = await repo.list_upload_metadata(member['id'], limit=limit + 1, offset=offset)
        items = []
        for row in rows[:limit]:
            name = row.get('name')
            # Uploads already store basenames; also guard legacy metadata.
            name = (name if isinstance(name, str) else '').replace('\\', '/').rsplit('/', 1)[-1][:180]
            items.append({'id': row['id'], 'name': name or '이름 없는 파일', 'created_at': row['created_at']})
        return {'member_id': member['id'], 'items': items, 'has_more': len(rows) > limit}

    @app.post('/api/attachments/upload')
    async def upload(request: Request, file: UploadFile = File(...)):
        member = await security.user(request)
        content = await file.read(settings.max_file_bytes + 1)
        row = await files.create(member['id'], file.filename or 'attachment', content)
        common = {'id': row['id'], 'name': row['filename'], 'mime_type': row['mime_type']}
        attachment = ImageAttachment(**common, preview_url=await image_preview(member['id'], row['id'])) if row['image'] else FileAttachment(**common)
        await chat.store.save_attachment(attachment, {'member': member})
        return attachment.model_dump(mode='json', context={'exclude_metadata': True}, exclude_none=True)

    @app.get('/api/file-preview/{id}')
    async def preview(id: str, token: str = ''):
        row = await repo.get('file_previews', digest(token)) if token else None
        if not row or row['data']['file_id'] != id or is_expired(row['data']['expires_at']): raise HTTPException(401, '미리보기 링크가 만료되었습니다.')
        member = await repo.member(row['owner_id'])
        if not member or not member.get('active'): raise HTTPException(403, '미리보기를 사용할 수 없습니다.')
        metadata = await files.read(row['owner_id'], id)
        if not metadata['image']: raise HTTPException(415, '이미지 미리보기만 지원합니다.')
        return Response(await files.bytes(row['owner_id'], id), media_type=metadata['mime_type'], headers={'Cache-Control': 'private, no-store'})

    @app.post('/api/chatkit')
    async def chatkit(request: Request):
        member = await security.user(request)
        project_id = request.headers.get('x-salesos-project')
        if project_id is not None:
            await projects.get(member['id'], project_id)
        selected_model = request.headers.get('x-salesos-model')
        if selected_model is not None:
            try: settings.select_chat_model(selected_model)
            except ValueError as exc: raise HTTPException(400, str(exc)) from None
        context = {'member': member, 'channel': 'web', 'project_id': project_id, 'model': selected_model}
        raw = await request.body()
        if len(raw) > 1024 * 1024: raise HTTPException(413, '대화 요청이 너무 큽니다.')
        try:
            parsed = json.loads(raw)
            params = parsed.get('params', {})
            if 'project_id' in params or any(isinstance(value, dict) and 'project_id' in value
                    for value in (parsed.get('metadata'), params.get('metadata'))):
                raise HTTPException(400, '프로젝트는 대화 화면에서 선택해 주세요.')
            if params.get('thread_id'): await chat.store.load_thread(params['thread_id'], context)
            user_input = params.get('input', {})
            requested_model = user_input.get('inference_options', {}).get('model')
            if requested_model is not None:
                try: settings.select_chat_model(requested_model)
                except ValueError as exc: raise HTTPException(400, str(exc)) from None
            if sum(len(c.get('text', '')) for c in user_input.get('content', [])) > 50000: raise HTTPException(413, '한 번에 보낼 수 있는 대화 길이를 초과했습니다.')
            if len(user_input.get('attachments', [])) > 5: raise HTTPException(400, '파일은 한 번에 5개까지 첨부해 주세요.')
            for id in user_input.get('attachments', []): await chat.store.load_attachment(id, context)
            result = await chat.process(raw, context)
        except (ValueError, TypeError, AttributeError, ValidationError):
            raise HTTPException(400, 'ChatKit 요청 형식이 올바르지 않습니다.') from None
        if isinstance(result, StreamingResult):
            return StreamingResponse(result, media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
        return Response(result.json, media_type='application/json')

    @app.post('/api/line/link-code')
    async def line_code(request: Request):
        member = await security.user(request)
        return await line.link_code(member['id'])

    @app.post('/api/internal/line/events')
    async def line_events(request: Request):
        security.internal(request)
        raw = await request.body(); signature = request.headers.get('x-line-signature', '')
        if len(raw) > 2 * 1024 * 1024: raise HTTPException(413, 'LINE 이벤트 크기가 너무 큽니다.')
        if not signature:
            try:
                body = json.loads(raw)
                signature = body['signature']
                raw = base64.b64decode(body['raw_body_base64'], validate=True)
            except (ValueError, KeyError, TypeError): raise HTTPException(400, 'LINE 원본 이벤트와 서명이 필요합니다.') from None
        return await line.ingest(raw, signature)

    @app.post('/api/internal/line/outbound/claim')
    async def line_claim(request: Request):
        security.internal(request)
        return await line.claim_outbound()

    @app.post('/api/internal/line/outbound/{id}/result')
    async def line_result(id: str, request: Request):
        security.internal(request)
        return await line.outbound_result(id, await request.json())

    @app.post('/api/internal/reconcile')
    async def reconcile(request: Request):
        security.internal(request)
        return await line.reconcile()

    return app


app = create_app()
