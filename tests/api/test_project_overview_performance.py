"""Bundled project reads must keep live authentication, scoping and partial failures."""
import asyncio
from datetime import datetime, timezone

import pytest
from chatkit.store import NotFoundError
from chatkit.types import ThreadMetadata
from fastapi import HTTPException

from salesos_api.projects import ProjectCreate
from salesos_api.security import DEV_USER_ID


def make_project(client, headers, name='내 프로젝트'):
    response = client.post('/api/projects', headers=headers, json={'name': name, 'overview': '# 목표'})
    assert response.status_code == 201
    return response.json()


def count_authentication(app, monkeypatch):
    calls = []
    original = app.state.security.user

    async def authenticate(request):
        calls.append(request)
        return await original(request)

    monkeypatch.setattr(app.state.security, 'user', authenticate)
    return calls


def test_project_overview_authenticates_once_and_scopes_paginated_threads(client, app, headers, monkeypatch):
    mine = make_project(client, headers)
    another = make_project(client, headers, '다른 프로젝트')

    async def seed():
        for thread_id, owner, project_id in [
            ('thr_a', DEV_USER_ID, mine['id']), ('thr_b', DEV_USER_ID, mine['id']),
            ('thr_elsewhere', DEV_USER_ID, another['id']),
            ('thr_general', DEV_USER_ID, None), ('thr_other_owner', 'other-owner', mine['id']),
        ]:
            thread = ThreadMetadata(id=thread_id, title=thread_id,
                                    created_at=datetime(2026, 11, 15, tzinfo=timezone.utc),
                                    metadata={'project_id': project_id})
            await app.state.repo.save('threads', thread_id, owner, thread.model_dump(mode='json', exclude={'items'}))

    asyncio.run(seed())
    authenticated = count_authentication(app, monkeypatch)
    url = '/api/projects/' + mine['id'] + '/overview'
    response = client.get(url, headers=headers, params={'limit': 1, 'owner_id': 'other-owner'})
    assert response.status_code == 200
    body = response.json()
    assert body['member_id'] == DEV_USER_ID
    assert body['project'] == mine and body['threads_error'] == ''
    assert [item['id'] for item in body['threads']['items']] == ['thr_b']
    assert body['threads']['has_more'] and body['threads']['after'] == 'thr_b'
    assert len(authenticated) == 1
    assert response.headers['cache-control'] == 'no-store'
    last = client.get(url, headers=headers, params={'limit': 1, 'after': 'thr_b'}).json()
    assert [item['id'] for item in last['threads']['items']] == ['thr_a']
    assert last['threads']['has_more'] is False and last['threads']['after'] is None
    assert len(authenticated) == 2, 'each request still authenticates independently'
    invalid = client.get(url, headers=headers, params={'after': 'thr_elsewhere'}).json()
    assert invalid['project'] == mine and invalid['threads']['items'] == []
    assert invalid['threads_error']
    assert client.get(url, headers=headers, params={'limit': 101}).status_code == 422


def test_project_list_includes_current_member_without_separate_auth_call(client, app, headers, monkeypatch):
    mine = make_project(client, headers)
    asyncio.run(app.state.projects.create('other-owner', ProjectCreate(name='다른 직원')))
    authenticated = count_authentication(app, monkeypatch)
    response = client.get('/api/projects?owner_id=other-owner', headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body['member_id'] == DEV_USER_ID
    assert [item['id'] for item in body['items']] == [mine['id']]
    assert body['has_more'] is False and body['after'] is None
    assert len(authenticated) == 1


def test_overview_rejects_guests_and_other_owners_before_loading_threads(client, app, headers, monkeypatch):
    other = asyncio.run(app.state.projects.create('other-owner', ProjectCreate(name='다른 직원')))

    async def forbidden(*args, **kwargs):
        raise AssertionError('threads must not load before authentication and project ownership checks')

    monkeypatch.setattr(app.state.chat.store, 'load_threads', forbidden)
    url = '/api/projects/' + other['id'] + '/overview'
    assert client.get(url).status_code == 401
    assert client.get(url, headers=headers).status_code == 404
    monkeypatch.setattr(app.state.projects, 'get', forbidden)
    assert client.get(url).status_code == 401


@pytest.mark.parametrize('failure', [HTTPException(503, 'private upstream failure'), NotFoundError('private cursor failure')])
def test_overview_keeps_owned_markdown_when_threads_are_unavailable(client, app, headers, monkeypatch, failure):
    mine = make_project(client, headers)

    async def unavailable(*args, **kwargs):
        raise failure

    monkeypatch.setattr(app.state.chat.store, 'load_threads', unavailable)
    response = client.get('/api/projects/' + mine['id'] + '/overview', headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body['project'] == mine and body['member_id'] == DEV_USER_ID
    assert body['threads'] == {'items': [], 'has_more': False, 'after': None}
    assert body['threads_error']
    assert 'private' not in response.text


def test_overview_never_turns_authorization_failure_into_partial_success(client, app, headers, monkeypatch):
    mine = make_project(client, headers)

    async def denied(*args, **kwargs):
        raise HTTPException(403, '권한이 없습니다.')

    monkeypatch.setattr(app.state.chat.store, 'load_threads', denied)
    assert client.get('/api/projects/' + mine['id'] + '/overview', headers=headers).status_code == 403
