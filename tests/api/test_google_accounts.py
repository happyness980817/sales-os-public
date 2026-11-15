import asyncio
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import HTTPException

from salesos_api.providers import GOOGLE_SCOPES
from salesos_api.tools import BusinessTools, GOOGLE_TOOLS, TOOLS


class GoogleMock:
    """Only synthetic accounts; every OAuth/API request stays in MockTransport."""

    def __init__(self, monkeypatch):
        self.codes = {}
        self.profiles = {}
        self.calls = []
        self.sequence = 0
        self.on_refresh = None
        self.refresh_scope = None
        original = httpx.AsyncClient
        monkeypatch.setattr('salesos_api.providers.httpx.AsyncClient',
                            lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(self.handle)))

    def code(self, subject, services, *, refresh=True, email=None):
        self.sequence += 1
        code = f'code-{self.sequence}'
        access = f'access-{subject}-{self.sequence}'
        scopes = sorted({scope for service in services for scope in GOOGLE_SCOPES[service]})
        self.codes[code] = {'access_token': access, 'scope': ' '.join(scopes), 'expires_in': 3600}
        if refresh:
            self.codes[code]['refresh_token'] = f'refresh-{subject}'
        self.profiles[access] = {'sub': subject, 'email': email or f'{subject}@example.test'}
        return code

    async def handle(self, request):
        self.calls.append(request)
        if request.url.path == '/token':
            data = parse_qs(request.content.decode())
            if data['grant_type'] == ['authorization_code']:
                return httpx.Response(200, json=self.codes[data['code'][0]])
            token = data['refresh_token'][0]
            if self.on_refresh:
                await self.on_refresh(token)
            result = {'access_token': token + '-new', 'expires_in': 3600}
            if self.refresh_scope is not None:
                result['scope'] = self.refresh_scope
            return httpx.Response(200, json=result)
        if request.url.path == '/v1/userinfo':
            return httpx.Response(200, json=self.profiles[request.headers['authorization'][7:]])
        if request.url.host == 'sheets.googleapis.com' and request.method == 'PUT':
            return httpx.Response(200, json={'updatedCells': 1})
        if request.url.host == 'chat.googleapis.com':
            return httpx.Response(200, json={'spaces': [{'name': 'spaces/allowed'}], 'messages': [{'name': 'm1', 'text': 'meeting'}]})
        return httpx.Response(200, json={'files': [{'id': 'file1', 'name': 'meeting.txt'}]})


@pytest.fixture
def google(app, monkeypatch):
    providers = app.state.providers
    providers.settings.google_client_id = 'test-client'
    providers.settings.google_client_secret = 'test-secret'
    return providers, GoogleMock(monkeypatch)


async def begin(providers, owner, service, connection_id=None):
    await providers.repo.create_member({'id': owner, 'active': True})
    url = await providers.start(owner, service, connection_id)
    return parse_qs(urlparse(url).query)


async def connect(google, owner, subject, service='google_drive', *, services=None,
                  connection_id=None, refresh=True, email=None):
    providers, transport = google
    params = await begin(providers, owner, service, connection_id)
    code = transport.code(subject, services or [service], refresh=refresh, email=email)
    await providers.callback('google', params['state'][0], code)
    return providers.google_connection_id(owner, subject)


async def expire(providers, owner, connection_id):
    row = await providers.google_account(owner, connection_id)
    tokens = json.loads(providers.security.decrypt(row['data']['encrypted']))
    tokens['expires_at'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    await providers.repo.cas(row, {**row['data'], 'encrypted': providers.security.encrypt(json.dumps(tokens))})


async def status_error(status, awaitable):
    with pytest.raises(HTTPException) as error:
        await awaitable
    assert error.value.status_code == status


@pytest.mark.asyncio
async def test_two_accounts_preserve_credentials_and_summary_has_no_secrets(google):
    providers, transport = google
    first = await connect(google, 'alice', 'personal', email='same@example.test')
    token = await providers.google_token('alice', 'google_drive', first)
    second = await connect(google, 'alice', 'work', email='same@example.test')
    assert first != second
    assert await providers.google_token('alice', 'google_drive', first) == token
    accounts = await providers.accounts('alice', 'google_drive')
    assert {item['connection_id'] for item in accounts} == {first, second}
    summary = {item['id']: item for item in await providers.connections('alice')}
    assert summary['google_drive']['account_count'] == 2
    assert summary['google_drive']['connected'] and summary['google_drive']['enabled']
    assert summary['gmail']['connected'] is False
    rendered = json.dumps(summary)
    assert all(secret not in rendered for secret in ['access-personal', 'refresh-personal', 'encrypted', 'test-secret'])
    assert transport.calls[0].url.host == 'oauth2.googleapis.com'


@pytest.mark.asyncio
async def test_owner_isolation_applies_to_every_account_operation(google):
    providers, _ = google
    first = await connect(google, 'alice', 'shared')
    other = await connect(google, 'bob', 'shared')
    assert first != other
    assert {item['connection_id'] for item in await providers.accounts('bob', 'google_drive')} == {other}
    await status_error(404, providers.connection('bob', 'google_drive', first))
    await status_error(404, providers.google_token('bob', 'google_drive', first))
    await status_error(404, providers.start('bob', 'google_drive', first))
    await status_error(404, providers.toggle_account('bob', 'google_drive', first, False))
    await status_error(404, providers.disconnect('bob', 'google_drive', first))


@pytest.mark.asyncio
async def test_new_account_scopes_do_not_inherit_another_account(google):
    providers, transport = google
    await connect(google, 'alice', 'personal', 'gmail')
    params = await begin(providers, 'alice', 'google_drive')
    assert 'gmail.readonly' not in params['scope'][0]
    assert set(params['prompt'][0].split()) == {'select_account', 'consent'}
    await providers.callback('google', params['state'][0], transport.code('work', ['google_drive']))
    accounts = {item['account']: item for item in await providers.accounts('alice', 'gmail')}
    assert accounts['personal@example.test']['connected']
    assert accounts['work@example.test']['connected'] is False


@pytest.mark.asyncio
async def test_reauthorization_updates_same_account_and_preserves_service_toggles(google):
    providers, _ = google
    first = await connect(google, 'alice', 'personal')
    second = await connect(google, 'alice', 'work')
    await providers.toggle_account('alice', 'google_drive', first, False)
    target = await connect(google, 'alice', 'personal', 'gmail', connection_id=first,
                           services=['google_drive', 'gmail'], refresh=False)
    assert target == first and len(await providers.accounts('alice', 'google_drive')) == 2
    states = {item['connection_id']: item for item in await providers.accounts('alice', 'google_drive')}
    assert states[first]['enabled'] is False and states[second]['enabled'] is True
    assert await providers.google_token('alice', 'gmail', first)
    await status_error(409, providers.google_token('alice', 'gmail', second))
    row = await providers.google_account('alice', first)
    tokens = json.loads(providers.security.decrypt(row['data']['encrypted']))
    assert tokens['refresh_token'] == 'refresh-personal'


@pytest.mark.asyncio
async def test_targeted_reauthorization_rejects_different_google_identity(google):
    providers, transport = google
    first = await connect(google, 'alice', 'personal')
    before = await providers.google_token('alice', 'google_drive', first)
    params = await begin(providers, 'alice', 'gmail', first)
    assert GOOGLE_SCOPES['google_drive'][0] in params['scope'][0]
    await status_error(409, providers.callback('google', params['state'][0], transport.code('other', ['gmail'])))
    assert len(await providers.accounts('alice', 'google_drive')) == 1
    assert await providers.google_token('alice', 'google_drive', first) == before


@pytest.mark.asyncio
@pytest.mark.parametrize('targeted', [True, False])
async def test_pending_reauthorization_cannot_restore_a_disconnected_account(google, targeted):
    providers, transport = google
    first = await connect(google, 'alice', 'personal')
    params = await begin(providers, 'alice', 'gmail', first if targeted else None)
    await providers.disconnect('alice', 'google_drive', first)
    await status_error(409, providers.callback('google', params['state'][0],
                                              transport.code('personal', ['google_drive', 'gmail'])))
    assert await providers.accounts('alice', 'google_drive') == []


@pytest.mark.asyncio
async def test_different_account_cannot_borrow_existing_refresh_token(google):
    providers, transport = google
    await connect(google, 'alice', 'personal')
    params = await begin(providers, 'alice', 'google_drive')
    await status_error(400, providers.callback('google', params['state'][0], transport.code('other', ['google_drive'], refresh=False)))
    assert len(await providers.accounts('alice', 'google_drive')) == 1


@pytest.mark.asyncio
async def test_ambiguous_accounts_require_selection_and_disabled_accounts_are_rejected(google):
    providers, _ = google
    first = await connect(google, 'alice', 'personal')
    assert (await providers.connection('alice', 'google_drive'))['data']['connection_id'] == first
    second = await connect(google, 'alice', 'work')
    await status_error(409, providers.connection('alice', 'google_drive'))
    await status_error(409, providers.disconnect('alice', 'google_drive'))
    await providers.toggle_account('alice', 'google_drive', first, False)
    assert (await providers.connection('alice', 'google_drive'))['data']['connection_id'] == second
    await status_error(409, providers.connection('alice', 'google_drive', first))
    await providers.toggle_account('alice', 'google_drive', first, True)
    await status_error(409, providers.connection('alice', 'google_drive'))


@pytest.mark.asyncio
async def test_disconnect_isolated_by_account_and_service_and_does_not_resurrect(google):
    providers, _ = google
    first = await connect(google, 'alice', 'personal')
    second = await connect(google, 'alice', 'work')
    await connect(google, 'alice', 'personal', 'gmail', connection_id=first, services=['google_drive', 'gmail'])
    await providers.disconnect('alice', 'google_drive', first)
    await status_error(409, providers.connection('alice', 'google_drive', first))
    assert await providers.google_token('alice', 'gmail', first)
    assert await providers.google_token('alice', 'google_drive', second)
    await providers.disconnect('alice', 'gmail', first)
    await providers.migrate_google('alice')
    await status_error(404, providers.google_token('alice', 'gmail', first))
    deleted = await providers.repo.get('provider_secrets', first, 'alice')
    assert deleted['data']['revoked'] and 'encrypted' not in deleted['data']
    assert {item['connection_id'] for item in await providers.accounts('alice', 'google_drive')} == {second}


@pytest.mark.asyncio
async def test_refresh_uses_each_accounts_own_refresh_token(google):
    providers, transport = google
    first = await connect(google, 'alice', 'personal')
    second = await connect(google, 'alice', 'work')
    await expire(providers, 'alice', first)
    await expire(providers, 'alice', second)
    actual = await asyncio.gather(providers.google_token('alice', 'google_drive', first),
                                  providers.google_token('alice', 'google_drive', second))
    assert actual == ['refresh-personal-new', 'refresh-work-new']
    calls = [parse_qs(request.content.decode()) for request in transport.calls if request.url.path == '/token']
    refresh = [request['refresh_token'][0] for request in calls if 'refresh_token' in request]
    assert set(refresh) == {'refresh-personal', 'refresh-work'}


@pytest.mark.asyncio
async def test_toggle_during_refresh_cannot_be_overwritten(google):
    providers, transport = google
    first = await connect(google, 'alice', 'personal')
    await expire(providers, 'alice', first)
    async def disable(_):
        await providers.toggle_account('alice', 'google_drive', first, False)
    transport.on_refresh = disable
    await status_error(409, providers.google_token('alice', 'google_drive', first))
    assert (await providers.accounts('alice', 'google_drive'))[0]['enabled'] is False


@pytest.mark.asyncio
async def test_refresh_downscope_cannot_keep_removed_service_permission(google):
    providers, transport = google
    first = await connect(google, 'alice', 'personal')
    await expire(providers, 'alice', first)
    transport.refresh_scope = 'openid email'
    await status_error(409, providers.google_token('alice', 'google_drive', first))
    assert (await providers.accounts('alice', 'google_drive'))[0]['connected'] is False


@pytest.mark.asyncio
async def test_legacy_migration_resumes_and_binds_chat_spaces_to_only_old_account(google):
    providers, _ = google
    owner, subject = 'alice', 'legacy'
    scopes = GOOGLE_SCOPES['google_drive'] + GOOGLE_SCOPES['google_chat']
    tokens = {'access_token': 'old-access', 'refresh_token': 'old-refresh',
              'expires_at': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()}
    await providers.repo.save('provider_secrets', f'{owner}:google', owner,
                             {'subject': subject, 'account': 'legacy@example.test', 'scopes': scopes,
                              'encrypted': providers.security.encrypt(json.dumps(tokens)), 'version': 4})
    for service in ['google_drive', 'google_chat']:
        await providers.repo.save('connections', f'{owner}:{service}', owner,
                                 {'subject': subject, 'connected': True, 'enabled': service != 'google_drive'})
    await providers.repo.save('settings', f'{owner}:chat_spaces', owner, {'spaces': ['spaces/allowed']})
    await asyncio.gather(providers.migrate_google(owner), providers.migrate_google(owner))
    first = providers.google_connection_id(owner, subject)
    assert (await providers.accounts(owner, 'google_drive'))[0]['enabled'] is False
    assert await providers.google_token(owner, 'google_chat', first) == 'old-access'
    marker = await providers.repo.get('provider_secrets', f'{owner}:google', owner)
    assert marker['data']['migrated_to'] == first and 'encrypted' not in marker['data']
    second = await connect(google, owner, 'new', 'google_chat')
    assert await providers.repo.get('settings', f'{owner}:chat_spaces:{first}', owner)
    assert await providers.repo.get('settings', f'{owner}:chat_spaces:{second}', owner) is None
    await providers.disconnect(owner, 'google_drive', first)
    await providers.disconnect(owner, 'google_chat', first)
    await providers.migrate_google(owner)
    assert {item['connection_id'] for item in await providers.accounts(owner, 'google_chat')} == {second}


@pytest.mark.asyncio
async def test_legacy_migration_recovers_after_copy_before_marker_failure(google, monkeypatch):
    providers, _ = google
    encrypted = providers.security.encrypt(json.dumps({'access_token': 'legacy-test-only'}))
    await providers.repo.save('provider_secrets', 'alice:google', 'alice', {
        'subject': 'legacy', 'account': 'legacy@example.test', 'scopes': GOOGLE_SCOPES['google_drive'],
        'encrypted': encrypted, 'version': 1})
    await providers.repo.save('connections', 'alice:google_drive', 'alice', {'connected': True, 'enabled': False})
    original = providers.repo.cas
    interrupted = False
    async def interrupt_once(row, data):
        nonlocal interrupted
        if row['id'] == 'alice:google' and not interrupted:
            interrupted = True
            raise HTTPException(503, 'synthetic interruption')
        return await original(row, data)
    monkeypatch.setattr(providers.repo, 'cas', interrupt_once)
    await status_error(503, providers.migrate_google('alice'))
    await providers.migrate_google('alice')
    accounts = await providers.accounts('alice', 'google_drive')
    assert len(accounts) == 1 and accounts[0]['enabled'] is False
    stored = await providers.google_account('alice', accounts[0]['connection_id'])
    assert stored['data']['encrypted'] == encrypted


@pytest.mark.asyncio
async def test_tools_pin_account_include_source_and_reject_other_owner(google):
    providers, transport = google
    first = await connect(google, 'alice', 'personal')
    second = await connect(google, 'alice', 'work')
    tools = BusinessTools(providers.repo, providers, None, None)
    ambiguous = await tools.call('search_drive', {'query': 'meeting'}, 'alice', 'thread', 'call')
    assert ambiguous['status'] == 409
    result = await tools.call('search_drive', {'query': 'meeting', 'connection_id': second}, 'alice', 'thread', 'call')
    assert result['items'][0]['id'] == 'file1'
    assert result['source'] == {'connection_id': second, 'account': 'work@example.test'}
    assert transport.calls[-1].headers['authorization'].startswith('Bearer access-work-')
    denied = await tools.call('search_drive', {'query': 'meeting', 'connection_id': first}, 'bob', 'thread', 'call')
    assert denied['status'] == 404


@pytest.mark.asyncio
async def test_tool_writes_pin_account_and_replay_cannot_change_it(google):
    providers, transport = google
    first = await connect(google, 'alice', 'personal', 'google_sheets')
    second = await connect(google, 'alice', 'work', 'google_sheets')
    tools = BusinessTools(providers.repo, providers, None, None)
    args = {'spreadsheet_id': 'sheet123', 'range': 'Sheet1!A1', 'values': [['meeting']]}
    assert (await tools.call('update_sheet_range', args, 'alice', 'thread', 'call'))['status'] == 409
    result = await tools.call('update_sheet_range', {**args, 'connection_id': first}, 'alice', 'thread', 'call')
    assert result['saved'] and result['source']['connection_id'] == first
    changed = await tools.call('update_sheet_range', {**args, 'connection_id': second}, 'alice', 'thread', 'call')
    assert changed['status'] == 409
    assert len([request for request in transport.calls if request.method == 'PUT']) == 1


@pytest.mark.asyncio
async def test_google_chat_allowlist_does_not_spill_across_accounts(google):
    providers, _ = google
    first = await connect(google, 'alice', 'personal', 'google_chat')
    second = await connect(google, 'alice', 'work', 'google_chat')
    await providers.repo.save('settings', f'alice:chat_spaces:{first}', 'alice', {'spaces': ['spaces/allowed']})
    tools = BusinessTools(providers.repo, providers, None, None)
    yes = await tools.call('read_chat_messages', {'space': 'spaces/allowed', 'connection_id': first}, 'alice', 't', 'c')
    no = await tools.call('read_chat_messages', {'space': 'spaces/allowed', 'connection_id': second}, 'alice', 't', 'c')
    assert yes['messages'][0]['text'] == 'meeting' and no['status'] == 403


def test_google_tool_schemas_accept_optional_account_id():
    for tool in TOOLS:
        if tool['name'] in GOOGLE_TOOLS:
            assert tool['parameters']['properties']['connection_id']['type'] == 'string'
            assert 'connection_id' not in tool['parameters']['required']


def test_http_account_list_start_toggle_delete_and_legacy_toggle(google, client, headers):
    providers, transport = google
    owner = client.get('/api/me', headers=headers).json()['id']

    def add(subject, service='google_drive', connection_id=None, services=None):
        started = client.post(f'/api/connections/{service}/start', headers=headers,
                              json={'connection_id': connection_id} if connection_id else {})
        assert started.status_code == 200
        params = parse_qs(urlparse(started.json()['url']).query)
        result = client.get('/api/connections/google/callback', params={
            'state': params['state'][0], 'code': transport.code(subject, services or [service])}, follow_redirects=False)
        assert result.status_code == 303
        return providers.google_connection_id(owner, subject)

    first = add('personal')
    assert client.get('/api/connections/google_drive/accounts').status_code == 401
    listed = client.get('/api/connections/google_drive/accounts', headers=headers).json()['items']
    assert listed[0]['id'] == listed[0]['connection_id'] == first
    assert 'encrypted' not in json.dumps(listed) and 'refresh_token' not in json.dumps(listed)
    target = f'/api/connections/google_drive/accounts/{first}'
    assert client.patch(target, headers=headers, json={'enabled': False}).status_code == 200
    # The compatibility endpoint must also allow re-enabling the only account.
    assert client.patch('/api/connections/google_drive', headers=headers, json={'enabled': True}).status_code == 200
    second = add('work')
    assert client.patch('/api/connections/google_drive', headers=headers, json={'enabled': False}).status_code == 409
    assert client.delete('/api/connections/google_drive', headers=headers).status_code == 409
    foreign = asyncio.run(connect(google, 'other-employee', 'private'))
    foreign_path = f'/api/connections/google_drive/accounts/{foreign}'
    assert client.patch(foreign_path, headers=headers, json={'enabled': False}).status_code == 404
    assert client.delete(foreign_path, headers=headers).status_code == 404
    assert client.post('/api/connections/google_drive/start', headers=headers,
                       json={'connection_id': foreign}).status_code == 404
    assert client.delete(target, headers=headers).status_code == 200
    remaining = client.get('/api/connections/google_drive/accounts', headers=headers).json()['items']
    assert [item['connection_id'] for item in remaining] == [second]


def test_http_google_chat_settings_are_saved_for_the_selected_account(google, client, headers):
    providers, transport = google
    owner = client.get('/api/me', headers=headers).json()['id']
    first = asyncio.run(connect(google, owner, 'personal', 'google_chat'))
    second = asyncio.run(connect(google, owner, 'work', 'google_chat'))
    assert client.put('/api/settings/google-chat', headers=headers,
                      json={'spaces': ['spaces/allowed']}).status_code == 409
    assert client.put('/api/settings/google-chat', headers=headers,
                      json={'spaces': ['spaces/allowed'], 'connection_id': first}).status_code == 200
    enabled = client.get('/api/settings/google-chat', headers=headers, params={'connection_id': first}).json()
    disabled = client.get('/api/settings/google-chat', headers=headers, params={'connection_id': second}).json()
    assert enabled['items'][0]['allowed'] is True
    assert disabled['items'][0]['allowed'] is False
