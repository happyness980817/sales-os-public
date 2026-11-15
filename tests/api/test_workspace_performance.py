"""Latency regressions must preserve live authentication and owner isolation."""
import asyncio
from uuid import uuid4

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

from salesos_api.config import Settings
from salesos_api.main import create_app
from salesos_api.repository import Repository
from salesos_api.security import DEV_USER_ID


def test_supabase_pool_reuses_connections_but_never_reuses_employee_identity(monkeypatch):
    users = {'token-a': str(uuid4()), 'token-b': str(uuid4())}
    revoked = set()
    calls, clients = [], []
    original_client = httpx.AsyncClient

    def upstream(request):
        calls.append(request)
        if request.url.path == '/auth/v1/user':
            token = request.headers['authorization'].removeprefix('Bearer ')
            assert request.headers['apikey'] == 'fixture-public'
            return httpx.Response(200, json={
                'id': users[token], 'email': token + '@example.test',
                'email_confirmed_at': '2026-11-15T00:00:00Z', 'user_metadata': {},
            })
        assert request.url.path == '/rest/v1/salesos_members'
        assert request.headers['authorization'] == 'Bearer fixture-service'
        assert request.headers['apikey'] == 'fixture-service'
        user_id = request.url.params['auth_user_id'].removeprefix('eq.')
        assert user_id in users.values()
        return httpx.Response(200, json=[{
            'id': user_id, 'auth_user_id': user_id, 'email': 'employee@example.test',
            'display_name': '직원', 'role': 'member', 'active': user_id not in revoked,
        }])

    def pool(**kwargs):
        client = original_client(**kwargs, transport=httpx.MockTransport(upstream))
        clients.append(client)
        return client

    monkeypatch.setattr('salesos_api.repository.httpx.AsyncClient', pool)
    app = create_app(Settings(_env_file=None, dev_mode=False, supabase_url='https://fixture.supabase.co',
                              supabase_publishable_key='fixture-public', supabase_service_key='fixture-service'))
    with TestClient(app) as client:
        for token in users:
            response = client.get('/api/me', headers={'Authorization': 'Bearer ' + token})
            assert response.status_code == 200
            assert response.json()['id'] == users[token]
        revoked.add(users['token-a'])
        assert client.get('/api/me', headers={'Authorization': 'Bearer token-a'}).status_code == 403
        assert len(clients) == 1
        assert not clients[0].is_closed
        assert [request.headers['authorization'] for request in calls if request.url.path == '/auth/v1/user'] == [
            'Bearer token-a', 'Bearer token-b', 'Bearer token-a']
        assert len(calls) == 6, 'every request must verify Auth and current active membership'
    assert clients[0].is_closed, 'the app lifespan owns the shared HTTP connection pool'


def test_workspace_authenticates_once_and_loads_independent_sections_concurrently(client, app, headers, monkeypatch):
    authenticated = []
    original_user = app.state.security.user
    connections_started, projects_started = asyncio.Event(), asyncio.Event()

    async def authenticate(request):
        authenticated.append(request)
        return await original_user(request)

    async def connections(owner):
        assert owner == DEV_USER_ID
        connections_started.set()
        await asyncio.wait_for(projects_started.wait(), timeout=1)
        return [{'id': 'google_drive', 'account': 'mine@example.test'}]

    async def projects(owner, limit):
        assert owner == DEV_USER_ID and limit == 8
        projects_started.set()
        await asyncio.wait_for(connections_started.wait(), timeout=1)
        return {'items': [{'id': 'mine', 'name': '내 프로젝트'}]}

    monkeypatch.setattr(app.state.security, 'user', authenticate)
    monkeypatch.setattr(app.state.providers, 'connections', connections)
    monkeypatch.setattr(app.state.projects, 'list', projects)
    response = client.get('/api/workspace?owner_id=another-employee', headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body['member']['id'] == DEV_USER_ID
    assert body['items'][0]['account'] == 'mine@example.test'
    assert body['projects'][0]['name'] == '내 프로젝트'
    assert body['projects_error'] == ''
    assert len(authenticated) == 1


def test_workspace_project_failure_keeps_authenticated_connection_data(client, app, headers, monkeypatch):
    async def unavailable(*args):
        raise HTTPException(503, 'private database failure')
    monkeypatch.setattr(app.state.projects, 'list', unavailable)
    response = client.get('/api/workspace', headers=headers)
    assert response.status_code == 200
    assert response.json()['member']['id'] == DEV_USER_ID
    assert len(response.json()['items']) == 8
    assert response.json()['projects'] == []
    assert response.json()['projects_error']
    assert 'private database failure' not in response.text


def test_workspace_guests_never_load_private_sections(client, app, monkeypatch):
    async def forbidden(*args):
        raise AssertionError('private data must not load before authentication')
    monkeypatch.setattr(app.state.projects, 'list', forbidden)
    monkeypatch.setattr(app.state.providers, 'connections', forbidden)
    assert client.get('/api/workspace').status_code == 401
