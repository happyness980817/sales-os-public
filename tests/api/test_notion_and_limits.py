import asyncio
import json
from types import SimpleNamespace
import pytest
import httpx
from fastapi import HTTPException
from salesos_api.config import Settings
from salesos_api.providers import Providers, NOTION_VERSION


async def seed_notion(app, owner='employee-a', refresh='refresh-old'):
    providers = app.state.providers
    providers.settings.notion_client_id = 'test-client-id'
    providers.settings.notion_client_secret = 'test-client-secret'
    await app.state.repo.save('connections', f'{owner}:notion', owner, {
        'connected': True, 'enabled': True, 'version': 1, 'subject': 'workspace-a'})
    await app.state.repo.save('provider_secrets', f'{owner}:notion', owner, {
        'subject': 'workspace-a', 'version': 1,
        'encrypted': app.state.security.encrypt(json.dumps({'access_token': 'access-old', 'refresh_token': refresh, 'workspace_id': 'workspace-a'}))})
    return providers, owner


def fake_client(monkeypatch, send, refresh):
    import salesos_api.providers as module
    class Client:
        def __init__(self, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def request(self, method, url, **kwargs): return await send(method, url, **kwargs)
        async def post(self, url, **kwargs): return await refresh(url, **kwargs)
    monkeypatch.setattr(module.httpx, 'AsyncClient', Client)


def response(status, payload):
    return SimpleNamespace(status_code=status, json=lambda: payload)


@pytest.mark.asyncio
async def test_notion_401_rotates_and_persists_pair_then_retries_once(app, monkeypatch):
    providers, owner = await seed_notion(app)
    calls = []; refreshes = []
    original = {'parent': {'page_id': 'page-a'}, 'properties': {}}
    async def send(method, url, headers, **kwargs):
        calls.append(headers['Authorization'])
        assert method == 'POST' and url == 'https://api.notion.com/v1/pages'
        assert kwargs['json'] == original
        assert headers['Notion-Version'] == NOTION_VERSION
        return response(401, {}) if headers['Authorization'] == 'Bearer access-old' else response(200, {'id': 'new-page'})
    async def refresh(url, auth, headers, json):
        refreshes.append(json)
        assert url == 'https://api.notion.com/v1/oauth/token'
        assert auth == ('test-client-id', 'test-client-secret')
        assert headers['Notion-Version'] == NOTION_VERSION
        assert json == {'grant_type': 'refresh_token', 'refresh_token': 'refresh-old'}
        return response(200, {'access_token': 'access-new', 'refresh_token': 'refresh-new'})
    fake_client(monkeypatch, send, refresh)
    result = await providers.notion(owner, 'POST', 'pages', json=original)
    assert result == {'id': 'new-page'}
    assert calls == ['Bearer access-old', 'Bearer access-new']
    row = await app.state.repo.get('provider_secrets', owner + ':notion', owner)
    tokens = json.loads(app.state.security.decrypt(row['data']['encrypted']))
    assert tokens['access_token'] == 'access-new'
    assert tokens['refresh_token'] == 'refresh-new'
    assert tokens['workspace_id'] == 'workspace-a'
    assert 'refresh_lease' not in row['data']
    assert 'access-new' not in row['data']['encrypted']
    await providers.notion(owner, 'POST', 'pages', json=original)
    assert len(refreshes) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('status', [403, 429, 500])
async def test_notion_does_not_retry_non_401_write_errors(app, monkeypatch, status):
    providers, owner = await seed_notion(app)
    calls = []
    async def send(*args, **kwargs):
        calls.append(1); return response(status, {})
    async def refresh(*args, **kwargs):
        raise AssertionError('Non-401 must never refresh/replay an external write')
    fake_client(monkeypatch, send, refresh)
    with pytest.raises(HTTPException) as caught:
        await providers.notion(owner, 'POST', 'pages', json={'title': 'request'})
    assert caught.value.status_code == 502
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_notion_refresh_rejection_requires_reconnect_without_leaking_token(app, monkeypatch):
    providers, owner = await seed_notion(app)
    calls = []; refreshes = []
    async def send(*args, **kwargs): calls.append(1); return response(401, {})
    async def refresh(*args, **kwargs):
        refreshes.append(1); return response(400, {'error': 'invalid_grant', 'secret': 'refresh-old'})
    fake_client(monkeypatch, send, refresh)
    with pytest.raises(HTTPException) as caught:
        await providers.notion(owner, 'GET', 'pages/page-a')
    assert caught.value.status_code == 409
    assert '다시 연결' in caught.value.detail
    assert 'refresh-old' not in caught.value.detail
    row = await app.state.repo.get('provider_secrets', owner + ':notion', owner)
    assert 'refresh_lease' not in row['data']
    assert len(calls) == len(refreshes) == 1


@pytest.mark.asyncio
async def test_notion_second_401_does_not_loop(app, monkeypatch):
    providers, owner = await seed_notion(app)
    calls = []; refreshes = []
    async def send(*args, **kwargs): calls.append(1); return response(401, {})
    async def refresh(*args, **kwargs):
        refreshes.append(1); return response(200, {'access_token': 'access-new', 'refresh_token': 'refresh-new'})
    fake_client(monkeypatch, send, refresh)
    with pytest.raises(HTTPException) as caught:
        await providers.notion(owner, 'GET', 'pages/page-a')
    assert caught.value.status_code == 409
    assert len(calls) == 2 and len(refreshes) == 1


@pytest.mark.asyncio
async def test_notion_rotation_is_serialized_across_provider_instances(app, monkeypatch):
    first, owner = await seed_notion(app)
    second = Providers(first.settings, app.state.repo, app.state.security)
    old_requests = 0; refreshes = []; both_failed = asyncio.Event()
    async def send(method, url, headers, **kwargs):
        nonlocal old_requests
        if headers['Authorization'] == 'Bearer access-old':
            old_requests += 1
            if old_requests == 2: both_failed.set()
            await both_failed.wait()
            return response(401, {})
        assert headers['Authorization'] == 'Bearer access-new'
        return response(200, {'object': 'list'})
    async def refresh(*args, **kwargs):
        refreshes.append(kwargs['json']['refresh_token'])
        await asyncio.sleep(0.02)
        return response(200, {'access_token': 'access-new', 'refresh_token': 'refresh-new'})
    fake_client(monkeypatch, send, refresh)
    results = await asyncio.wait_for(asyncio.gather(
        first.notion(owner, 'GET', 'pages/page-a'), second.notion(owner, 'GET', 'pages/page-b')), timeout=3)
    assert results == [{'object': 'list'}, {'object': 'list'}]
    assert refreshes == ['refresh-old']


@pytest.mark.asyncio
async def test_notion_disconnect_during_refresh_cannot_restore_credentials(app, monkeypatch):
    providers, owner = await seed_notion(app)
    calls = []
    async def send(*args, **kwargs): calls.append(1); return response(401, {})
    async def refresh(*args, **kwargs):
        await providers.disconnect(owner, 'notion')
        return response(200, {'access_token': 'access-new', 'refresh_token': 'refresh-new'})
    fake_client(monkeypatch, send, refresh)
    with pytest.raises(HTTPException) as caught:
        await providers.notion(owner, 'POST', 'pages', json={})
    assert caught.value.status_code == 409
    assert len(calls) == 1
    assert await app.state.repo.get('provider_secrets', owner + ':notion', owner) is None


@pytest.mark.asyncio
async def test_notion_reconnect_never_replays_old_operation_on_new_account(app, monkeypatch):
    providers, owner = await seed_notion(app)
    calls = []
    async def send(*args, **kwargs):
        calls.append(1)
        await app.state.repo.save('provider_secrets', owner + ':notion', owner, {'version': 2, 'subject': 'workspace-b',
            'encrypted': app.state.security.encrypt(json.dumps({'access_token': 'account-b-access', 'refresh_token': 'account-b-refresh'}))})
        await app.state.repo.save('connections', owner + ':notion', owner, {'connected': True, 'enabled': True, 'version': 2, 'subject': 'workspace-b'})
        return response(401, {})
    async def refresh(*args, **kwargs): raise AssertionError('Reconnected identity must stop the old request')
    fake_client(monkeypatch, send, refresh)
    with pytest.raises(HTTPException) as caught:
        await providers.notion(owner, 'POST', 'pages', json={})
    assert caught.value.status_code == 409
    assert len(calls) == 1
    row = await app.state.repo.get('provider_secrets', owner + ':notion', owner)
    assert row['data']['subject'] == 'workspace-b'


def test_max_file_bytes_environment_alias_and_default(monkeypatch):
    monkeypatch.delenv('SALESOS_MAX_FILE_BYTES', raising=False)
    monkeypatch.delenv('MAX_FILE_BYTES', raising=False)
    assert Settings(_env_file=None).max_file_bytes == 10 * 1024 * 1024
    monkeypatch.setenv('SALESOS_MAX_FILE_BYTES', '4194304')
    assert Settings(_env_file=None).max_file_bytes == 4 * 1024 * 1024


def test_upload_honors_public_config_limit(client, headers, app):
    app.state.files.settings.max_file_bytes = 1024
    assert client.get('/api/config').json()['max_file_bytes'] == 1024
    response = client.post('/api/attachments/upload', headers=headers, files={'file': ('too-big.txt', b'a' * 1025, 'text/plain')})
    assert response.status_code == 413
    assert '10MB' not in response.json()['detail']
    assert client.post('/api/attachments/upload', headers=headers, files={'file': ('fits.txt', b'a' * 1024, 'text/plain')}).status_code == 200

def test_device_limit_defaults_and_explicit_deployment_cap(monkeypatch):
    monkeypatch.delenv('SALESOS_MAX_FILE_BYTES', raising=False)
    monkeypatch.delenv('MAX_FILE_BYTES', raising=False)
    monkeypatch.delenv('SALESOS_DEVICE_MAX_FILE_BYTES', raising=False)
    assert Settings(_env_file=None).device_file_limit == 10 * 1024 * 1024
    monkeypatch.setenv('SALESOS_MAX_FILE_BYTES', '4194304')
    monkeypatch.setenv('SALESOS_DEVICE_MAX_FILE_BYTES', '3145728')
    settings = Settings(_env_file=None)
    assert settings.max_file_bytes == 4 * 1024 * 1024
    assert settings.device_file_limit == 3 * 1024 * 1024
    settings.max_file_bytes = 1024
    assert settings.device_file_limit == 1024


def test_device_receives_limit_and_server_rejects_encoded_boundary(client, headers, app):
    import base64
    settings = app.state.files.settings
    settings.max_file_bytes = 4096
    settings.device_max_file_bytes = 1024
    public = client.get('/api/config').json()
    assert public['max_file_bytes'] == 4096
    assert public['device_max_file_bytes'] == 1024
    code = client.post('/api/device-enrollments', headers=headers).json()['code']
    enrolled = client.post('/api/device/enroll', json={'code': code, 'name': 'PC'}).json()
    assert enrolled['max_file_bytes'] == 1024
    device_auth = {'Authorization': 'Bearer ' + enrolled['device_token']}
    assert client.post('/api/device/heartbeat', headers=device_auth).json()['max_file_bytes'] == 1024
    client.put('/api/device/roots', headers=device_auth, json={'roots': [{'id': 'root', 'name': '업무'}]})
    job = client.post('/api/local-files/read', headers=headers, json={'device_id': enrolled['device_id'], 'root_id': 'root', 'path': 'large.txt'}).json()
    claimed = client.post('/api/device/jobs/claim', headers=device_auth).json()
    assert claimed['max_file_bytes'] == claimed['job']['max_file_bytes'] == 1024
    # 1024 and 1025 bytes both encode to 1368 base64 characters: validate decoded size too.
    payload = {'ok': True, 'relative_path': 'large.txt', 'filename': 'large.txt', 'content_base64': base64.b64encode(b'x' * 1025).decode()}
    endpoint = f"/api/device/jobs/{job['id']}/result"
    assert client.post(endpoint, headers=device_auth, json=payload).status_code == 413
    assert client.post(endpoint, headers=device_auth, json={'ok': False, 'error': 'FILE_TOO_LARGE: private local path must not be echoed'}).status_code == 200
    saved = client.get('/api/jobs/' + job['id'], headers=headers).json()
    assert saved['status'] == 'failed'
    assert 'PC 읽기 한도' in saved['error']
    assert 'private local path' not in saved['error']
    # Existing devices learn a changed deployment setting even when no jobs exist.
    settings.device_max_file_bytes = 512
    assert client.post('/api/device/jobs/claim', headers=device_auth).json() == {'job': None, 'max_file_bytes': 512}
