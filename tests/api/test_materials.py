"""Personal upload metadata listing; never expose PC sources or storage capabilities."""
import asyncio
import io
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from salesos_api.config import Settings
from salesos_api.repository import Repository
from salesos_api.security import DEV_USER_ID
import salesos_api.security as security_module


def upload(client, headers, name, content, mime='text/plain'):
    response = client.post('/api/attachments/upload', headers=headers,
                           files={'file': (name, content, mime)})
    assert response.status_code == 200, response.text
    return response.json()


def test_materials_requires_login_and_empty_list_is_honest(client, headers):
    assert client.get('/api/materials').status_code == 401
    response = client.get('/api/materials', headers=headers)
    assert response.status_code == 200
    assert response.json() == {'member_id': DEV_USER_ID, 'items': [], 'has_more': False}
    assert response.headers['cache-control'] == 'no-store'


def test_real_uploads_are_newest_first_paginated_and_metadata_only(client, app, headers):
    older = upload(client, headers, 'folder/meeting.md', b'private-meeting-content', 'text/markdown')
    newer = upload(client, headers, 'proposal.txt', b'private-proposal-content')
    picture = io.BytesIO()
    Image.new('RGB', (4, 4), 'white').save(picture, 'PNG')
    image = upload(client, headers, 'card.png', picture.getvalue(), 'image/png')
    repo = app.state.repo
    for attachment, stamp in [
        (older, '2026-11-01T00:00:00+00:00'),
        (newer, '2026-11-02T00:00:00+00:00'),
        (image, '2026-11-03T00:00:00+00:00'),
    ]:
        repo.db.execute("update records set created_at=? where namespace='attachments' and id=?",
                        (stamp, attachment['id']))
    # Touching an old attachment must not change its upload date or move it to the top.
    repo.db.execute("update records set updated_at=? where namespace='attachments' and id=?",
                    ('2026-12-01T00:00:00+00:00', older['id']))
    repo.db.commit()
    pc_file = asyncio.run(app.state.files.create(DEV_USER_ID, 'pc-private.txt', b'pc-only',
                        source={'device_id': 'device-fixture', 'root_id': 'root-fixture', 'relative_path': 'pc-private.txt'}))
    asyncio.run(repo.insert('attachments', 'other-employee-file', 'other-employee',
                            {'name': 'other-private.txt', 'preview_url': 'https://private.invalid/token'}))
    first = client.get('/api/materials?limit=2&offset=0', headers=headers)
    assert first.status_code == 200
    assert first.json() == {
        'member_id': DEV_USER_ID, 'items': [
            {'id': image['id'], 'name': 'card.png', 'created_at': '2026-11-03T00:00:00+00:00'},
            {'id': newer['id'], 'name': 'proposal.txt', 'created_at': '2026-11-02T00:00:00+00:00'},
        ], 'has_more': True,
    }
    second = client.get('/api/materials?limit=2&offset=2', headers=headers)
    assert second.json() == {
        'member_id': DEV_USER_ID, 'items': [{'id': older['id'], 'name': 'meeting.md', 'created_at': '2026-11-01T00:00:00+00:00'}],
        'has_more': False,
    }
    all_text = first.text + second.text
    for forbidden in [image['preview_url'], 'private-meeting-content', 'private-proposal-content',
                      'pc-private.txt', pc_file['id'], 'other-private.txt', 'object_path', 'owner_id']:
        assert forbidden not in all_text
    assert client.get('/api/materials?offset=3', headers=headers).json() == {'member_id': DEV_USER_ID, 'items': [], 'has_more': False}


def test_equal_upload_dates_have_stable_id_order_and_deleted_attachments_disappear(client, app, headers):
    for id in ['atc_a', 'atc_z']:
        asyncio.run(app.state.repo.insert('attachments', id, DEV_USER_ID, {'name': id + '.txt'}))
    app.state.repo.db.execute("update records set created_at=? where namespace='attachments'",
                             ('2026-11-01T00:00:00+00:00',))
    app.state.repo.db.commit()
    assert client.get('/api/materials?limit=1', headers=headers).json()['items'][0]['id'] == 'atc_z'
    assert client.get('/api/materials?limit=1&offset=1', headers=headers).json()['items'][0]['id'] == 'atc_a'
    asyncio.run(app.state.chat.store.delete_attachment('atc_z', {'member': {'id': DEV_USER_ID}}))
    remaining = client.get('/api/materials', headers=headers).json()
    assert [item['id'] for item in remaining['items']] == ['atc_a']
    assert remaining['has_more'] is False


@pytest.mark.parametrize('query', ['limit=0', 'limit=101', 'offset=-1', 'offset=100001', 'limit=invalid'])
def test_materials_pagination_is_bounded(client, headers, query):
    response = client.get('/api/materials?' + query, headers=headers)
    assert response.status_code == 422
    assert 'invalid' not in response.text


def test_verified_users_cannot_select_another_owner_and_inactive_members_are_denied(client, app, monkeypatch):
    users = {'user-a': str(uuid4()), 'user-b': str(uuid4()), 'inactive': str(uuid4())}
    app.state.security.settings.supabase_publishable_key = 'fixture-publishable-key'
    for token, id in users.items():
        asyncio.run(app.state.repo.create_member({
            'id': id, 'auth_user_id': id, 'email': token + '@example.com',
            'display_name': token, 'role': 'member', 'active': token != 'inactive',
        }))
        asyncio.run(app.state.repo.insert('attachments', 'atc_' + token, id, {'name': token + '.txt'}))

    class AuthClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def aclose(self):
            pass

        async def get(self, url, headers, **kwargs):
            assert url.endswith('/auth/v1/user')
            token = headers['Authorization'].removeprefix('Bearer ')
            if token not in users:
                return httpx.Response(401, json={})
            return httpx.Response(200, json={
                'id': users[token], 'email': token + '@example.com',
                'email_confirmed_at': '2026-11-15T00:00:00Z', 'user_metadata': {},
            })

    monkeypatch.setattr(security_module.httpx, 'AsyncClient', AuthClient)
    for token, other in [('user-a', 'user-b'), ('user-b', 'user-a')]:
        response = client.get('/api/materials', params={'owner_id': users[other]},
                              headers={'Authorization': 'Bearer ' + token})
        assert response.status_code == 200
        assert [item['name'] for item in response.json()['items']] == [token + '.txt']
        assert users[other] not in response.text
    assert client.get('/api/materials', headers={'Authorization': 'Bearer inactive'}).status_code == 403
    assert client.get('/api/materials', headers={'Authorization': 'Bearer forged'}).status_code == 401


@pytest.mark.asyncio
async def test_supabase_projection_is_owner_scoped_metadata_only_and_paginated(monkeypatch):
    repo = Repository(Settings(_env_file=None, dev_mode=False, supabase_service_key='fixture-service-key'))
    expected = [{'id': 'atc_fixture', 'name': 'fixture.txt', 'created_at': '2026-11-15T00:00:00Z'}]

    async def request(method, path, *, params):
        assert method == 'GET'
        assert path == 'salesos_records'
        assert params == {
            'namespace': 'eq.attachments', 'owner_id': 'eq.owner-fixture',
            'select': 'id,name:data->>name,created_at',
            'order': 'created_at.desc,id.desc', 'limit': '51', 'offset': '100',
        }
        return expected

    monkeypatch.setattr(repo, 'request', request)
    assert await repo.list_upload_metadata('owner-fixture', limit=51, offset=100) == expected
