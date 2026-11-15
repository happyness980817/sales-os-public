"""Screen reads authenticate once, preserve scope, and bound independent IO."""
import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from salesos_api.chat import VerifiedProjectScope
from salesos_api.projects import ProjectCreate
from salesos_api.security import DEV_USER_ID


@pytest.mark.parametrize('path', [
    '/api/connections', '/api/connections/google_drive/accounts',
    '/api/jobs', '/api/devices', '/api/materials',
])
def test_screen_read_returns_its_verified_member_with_one_auth_check(client, app, headers, monkeypatch, path):
    calls = []
    original = app.state.security.user

    async def authenticate(request):
        calls.append(request)
        return await original(request)

    monkeypatch.setattr(app.state.security, 'user', authenticate)
    assert client.get(path).status_code == 401
    assert client.get(path, headers={**headers, 'X-SalesOS-Member': 'other-member'}).status_code == 409
    calls.clear()
    response = client.get(path + '?owner_id=other-member', headers=headers)
    assert response.status_code == 200
    assert response.json()['member_id'] == DEV_USER_ID
    assert len(calls) == 1
    assert response.headers['cache-control'] == 'no-store'


def test_project_overview_reuses_owned_project_only_within_each_request(client, app, headers, monkeypatch):
    project = client.post('/api/projects', headers=headers, json={'name': 'Overview'}).json()
    original = app.state.repo.get
    project_reads = []

    async def get(namespace, id, owner=None):
        if namespace == 'projects':
            project_reads.append((id, owner))
        return await original(namespace, id, owner)

    monkeypatch.setattr(app.state.repo, 'get', get)
    url = '/api/projects/' + project['id'] + '/overview'
    for count in (1, 2):
        response = client.get(url, headers=headers)
        assert response.status_code == 200
        assert response.json()['project'] == project
        assert project_reads == [(project['id'], DEV_USER_ID)] * count
    app.state.repo.db.execute("delete from records where namespace='projects' and id=?", (project['id'],))
    app.state.repo.db.commit()
    assert client.get(url, headers=headers).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize('marker', ['wrong-owner', 'wrong-project', 'json-object'])
async def test_scope_reuse_cannot_apply_to_another_scope_or_json_object(app, monkeypatch, marker):
    project = await app.state.projects.create(DEV_USER_ID, ProjectCreate(name='Owned'))
    scope = {
        'wrong-owner': VerifiedProjectScope('other-owner', project['id']),
        'wrong-project': VerifiedProjectScope(DEV_USER_ID, 'prj_' + 'a' * 32),
        'json-object': {'owner_id': DEV_USER_ID, 'project_id': project['id']},
    }[marker]
    checks = []
    original = app.state.chat.store.validate_project

    async def validate(owner, project_id):
        checks.append((owner, project_id))
        return await original(owner, project_id)

    monkeypatch.setattr(app.state.chat.store, 'validate_project', validate)
    await app.state.chat.store.load_threads(10, None, 'desc', {
        'member': {'id': DEV_USER_ID}, 'project_id': project['id'], '_verified_project_scope': scope,
    })
    assert checks == [(DEV_USER_ID, project['id'])]


def test_job_file_checks_run_concurrently_with_a_limit_and_keep_order(client, app, headers, monkeypatch):
    async def seed():
        for index in range(14):
            await app.state.repo.insert('jobs', 'job-' + str(index), DEV_USER_ID, {
                'status': 'succeeded', 'text': 'private request', 'event_id': 'private event',
                'result': {'file_id': 'file-' + str(index), 'text': 'result text'},
            })
        return [row['id'] for row in await app.state.repo.list('jobs', DEV_USER_ID, limit=100)]

    expected = asyncio.run(seed())
    state = {'active': 0, 'peak': 0, 'seen': []}
    first_batch = asyncio.Event()

    async def read(owner, file_id):
        assert owner == DEV_USER_ID
        state['active'] += 1
        state['peak'] = max(state['peak'], state['active'])
        state['seen'].append(file_id)
        if state['active'] == 6:
            first_batch.set()
        try:
            # A serial implementation cannot open the gate; no elapsed-time assertion.
            await asyncio.wait_for(first_batch.wait(), timeout=2)
            await asyncio.sleep(0)
            if file_id == 'file-4':
                raise HTTPException(403, 'revoked folder')
            return {'id': file_id}
        finally:
            state['active'] -= 1

    monkeypatch.setattr(app.state.files, 'read', read)
    response = client.get('/api/jobs', headers=headers)
    assert response.status_code == 200
    items = response.json()['items']
    assert [item['id'] for item in items] == expected
    assert state['peak'] == 6 and state['active'] == 0 and len(state['seen']) == 14
    revoked = next(item for item in items if item['id'] == 'job-4')
    assert revoked['result'] == {'file_id': 'file-4', 'unavailable': True}
    assert all('text' not in item and 'event_id' not in item for item in items)


def test_job_list_keeps_real_file_revocation_and_owner_checks(client, app, headers):
    async def seed():
        await app.state.repo.insert('devices', 'pc', DEV_USER_ID, {'revoked': True})
        await app.state.repo.insert('roots', 'pc:root', DEV_USER_ID, {'enabled': True})
        await app.state.repo.insert('files', 'revoked-file', DEV_USER_ID, {
            'source': {'device_id': 'pc', 'root_id': 'root'},
        })
        await app.state.repo.insert('jobs', 'mine', DEV_USER_ID, {
            'status': 'succeeded', 'result': {'file_id': 'revoked-file', 'text': 'private material'},
        })
        await app.state.repo.insert('jobs', 'someone-elses-job', 'someone-else', {'status': 'succeeded'})

    asyncio.run(seed())
    response = client.get('/api/jobs?owner_id=someone-else', headers=headers)
    assert response.status_code == 200
    assert response.json()['items'] == [{
        'id': 'mine', 'status': 'succeeded', 'result': {'file_id': 'revoked-file', 'unavailable': True},
    }]


@pytest.mark.asyncio
async def test_device_and_root_lists_load_together_with_owner_scoping(app, monkeypatch):
    started = set()
    ready = asyncio.Event()

    async def list_records(namespace, owner, **kwargs):
        assert owner == DEV_USER_ID
        started.add(namespace)
        if started == {'roots', 'devices'}:
            ready.set()
        await asyncio.wait_for(ready.wait(), timeout=2)
        if namespace == 'roots':
            return [
                {'data': {'device_id': 'pc', 'id': 'visible', 'name': 'Allowed', 'enabled': True}},
                {'data': {'device_id': 'pc', 'id': 'disabled', 'name': 'Revoked', 'enabled': False}},
            ]
        return [
            {'id': 'pc', 'data': {'name': 'Office PC', 'last_seen_at': datetime.now(timezone.utc).isoformat()}},
            {'id': 'old', 'data': {'name': 'Revoked PC', 'revoked': True}},
        ]

    monkeypatch.setattr(app.state.repo, 'list', list_records)
    items = await app.state.devices.list(DEV_USER_ID)
    assert started == {'roots', 'devices'}
    assert len(items) == 1 and items[0]['id'] == 'pc'
    assert items[0]['roots'] == [{'id': 'visible', 'name': 'Allowed', 'enabled': True}]
