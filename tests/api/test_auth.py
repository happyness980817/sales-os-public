"""Authentication failure classification and verified employee bootstrap."""
import json
from uuid import uuid4

import httpx
import pytest

import salesos_api.security as security_module

AUTH_HEADERS = {'Authorization': 'Bearer auth-test-access-token'}
PRIVATE_MARKER = 'upstream-private-detail-must-not-leak'


@pytest.fixture
def auth_response(app, monkeypatch):
    state = {'response': None, 'error': None}
    app.state.security.settings.supabase_publishable_key = 'auth-test-publishable-key'

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
            assert headers == {
                'apikey': 'auth-test-publishable-key',
                'Authorization': AUTH_HEADERS['Authorization'],
            }
            if state['error'] is not None:
                raise state['error']
            assert state['response'] is not None, 'A mocked auth response is required'
            return state['response']

    monkeypatch.setattr(security_module.httpx, 'AsyncClient', AuthClient)
    return state


def identity(**overrides):
    return {
        'id': str(uuid4()),
        'email': 'admin@example.com',
        'email_confirmed_at': '2026-11-15T00:00:00Z',
        'user_metadata': {'full_name': '관리자'},
        **overrides,
    }


def assert_no_members(app):
    assert app.state.security.repo.db.execute('select count(*) from members').fetchone()[0] == 0


@pytest.mark.parametrize('status', [400, 429, 500, 503, 302])
def test_auth_service_errors_preserve_session_as_temporary_failure(client, app, auth_response, status):
    auth_response['response'] = httpx.Response(status, json={'error': PRIVATE_MARKER})
    response = client.get('/api/me', headers=AUTH_HEADERS)
    assert response.status_code == 503
    assert '잠시 후' in response.json()['detail']
    assert PRIVATE_MARKER not in response.text
    assert_no_members(app)


@pytest.mark.parametrize('status', [401, 403])
def test_rejected_access_token_requires_login(client, app, auth_response, status):
    auth_response['response'] = httpx.Response(status, json={'error': PRIVATE_MARKER})
    response = client.get('/api/me', headers=AUTH_HEADERS)
    assert response.status_code == 401
    assert '다시 로그인' in response.json()['detail']
    assert PRIVATE_MARKER not in response.text
    assert_no_members(app)


def test_auth_connection_error_is_temporary_and_does_not_leak_details(client, app, auth_response):
    auth_response['error'] = httpx.ConnectError(PRIVATE_MARKER)
    response = client.get('/api/me', headers=AUTH_HEADERS)
    assert response.status_code == 503
    assert PRIVATE_MARKER not in response.text
    assert_no_members(app)


@pytest.mark.parametrize('payload', [
    None,
    [],
    {'id': 'not-a-uuid'},
    {'id': 123},
    identity(email={'private': PRIVATE_MARKER}),
    identity(email_confirmed_at=True),
    identity(user_metadata=['invalid']),
])
def test_malformed_identity_is_service_failure_without_bootstrap(client, app, auth_response, payload):
    app.state.security.settings.admin_emails = 'admin@example.com'
    auth_response['response'] = httpx.Response(200, json=payload)
    response = client.get('/api/me', headers=AUTH_HEADERS)
    assert response.status_code == 503
    assert '응답을 확인할 수 없습니다' in response.json()['detail']
    assert PRIVATE_MARKER not in response.text
    assert_no_members(app)


def test_invalid_json_is_service_failure_without_raw_response(client, app, auth_response):
    auth_response['response'] = httpx.Response(200, content=PRIVATE_MARKER.encode())
    response = client.get('/api/me', headers=AUTH_HEADERS)
    assert response.status_code == 503
    assert PRIVATE_MARKER not in response.text
    assert_no_members(app)


def test_confirmed_allowlisted_admin_bootstraps_once(client, app, auth_response):
    user = identity(email='Admin@Example.com')
    app.state.security.settings.admin_emails = ' admin@example.com '
    auth_response['response'] = httpx.Response(200, json=user)
    for _ in range(2):
        response = client.get('/api/me', headers=AUTH_HEADERS)
        assert response.status_code == 200
        assert response.json() == {
            'id': user['id'], 'email': 'admin@example.com',
            'display_name': '관리자', 'role': 'admin',
        }
    assert app.state.security.repo.db.execute('select count(*) from members').fetchone()[0] == 1


@pytest.mark.parametrize('confirmed_at', [None, ''])
def test_unconfirmed_allowlisted_email_cannot_become_admin(client, app, auth_response, confirmed_at):
    app.state.security.settings.admin_emails = 'admin@example.com'
    auth_response['response'] = httpx.Response(200, json=identity(email_confirmed_at=confirmed_at))
    assert client.get('/api/me', headers=AUTH_HEADERS).status_code == 403
    assert_no_members(app)


def test_allowlist_does_not_reactivate_existing_inactive_admin(client, app, auth_response):
    user = identity()
    app.state.security.settings.admin_emails = user['email']
    inactive = {
        'id': user['id'], 'auth_user_id': user['id'], 'email': user['email'],
        'display_name': '관리자', 'role': 'admin', 'active': False,
    }
    db = app.state.security.repo.db
    db.execute('insert into members values(?, ?)', (user['id'], json.dumps(inactive)))
    db.commit()
    auth_response['response'] = httpx.Response(200, json=user)
    assert client.get('/api/me', headers=AUTH_HEADERS).status_code == 403
    stored = json.loads(db.execute('select data from members where id=?', (user['id'],)).fetchone()['data'])
    assert stored['active'] is False


def test_stale_tab_cannot_act_as_newly_signed_in_employee(client, app, auth_response):
    app.state.security.settings.admin_emails = 'admin@example.com'
    user = identity()
    auth_response['response'] = httpx.Response(200, json=user)
    headers = {**AUTH_HEADERS, 'X-SalesOS-Member': str(uuid4())}
    response = client.post('/api/device-enrollments', headers=headers, json={})
    assert response.status_code == 409
    assert '계정이 변경' in response.json()['detail']
    assert_no_members(app)
    assert app.state.security.repo.db.execute('select count(*) from records').fetchone()[0] == 0


def test_screen_identity_is_only_a_guard_and_never_authorization(client, app, auth_response):
    user = identity()
    auth_response['response'] = httpx.Response(200, json=user)
    headers = {**AUTH_HEADERS, 'X-SalesOS-Member': user['id']}
    assert client.get('/api/me', headers=headers).status_code == 403
    assert_no_members(app)
    app.state.security.settings.admin_emails = 'admin@example.com'
    assert client.get('/api/me', headers=headers).status_code == 200
