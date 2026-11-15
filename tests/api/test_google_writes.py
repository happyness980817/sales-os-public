import asyncio
import copy
import re
from types import SimpleNamespace
import httpx
import pytest
from fastapi import HTTPException
from salesos_api.tools import BusinessTools


class ConnectedGoogle:
    def __init__(self):
        self.subject = 'google-subject-a'
        self.version = 1
        self.enabled = True
        self.switch_on_token = False

    async def connection(self, owner, provider, connection_id=None):
        if not self.enabled:
            raise HTTPException(409, '이 서비스는 대화에서 사용하지 않도록 설정되어 있습니다.')
        return {'owner_id': owner, 'data': {'subject': self.subject + ':' + owner, 'version': self.version,
                                          'connection_id': connection_id or 'google_' + owner, 'account': owner}}

    async def google_token(self, owner, provider, connection_id=None):
        if self.switch_on_token:
            self.subject = 'google-subject-b'
            self.version += 1
        return 'test-token-' + owner


@pytest.fixture
def google_tools(app):
    provider = ConnectedGoogle()
    return BusinessTools(app.state.repo, provider, None, None)


def mock_google(monkeypatch, handler):
    original = httpx.AsyncClient
    def client(**kwargs):
        return original(**kwargs, transport=httpx.MockTransport(handler))
    monkeypatch.setattr('salesos_api.tools.httpx.AsyncClient', client)


SHEET = {'spreadsheet_id': 'sheet_id_123', 'range': "'영업 현황'!A2:B3", 'values': [['미팅', '=1+1'], [True, 12.5]]}
EVENT = {'title': '고객 미팅', 'start_at': '2026-11-20T10:00:00+09:00', 'end_at': '2026-11-20T11:00:00+09:00', 'description': '견적 확인', 'location': '회의실 A'}


def returned_event(request):
    import json
    data = json.loads(request.content)
    return {**data, 'status': 'confirmed', 'htmlLink': 'https://www.google.com/calendar/event?eid=test-event'}


@pytest.mark.asyncio
async def test_sheet_put_is_raw_bounded_and_repeated_call_uses_saved_result(google_tools, monkeypatch):
    calls = []
    def handle(request):
        import json
        calls.append(request)
        assert request.method == 'PUT'
        assert request.url.host == 'sheets.googleapis.com'
        assert request.url.path.endswith("/values/'영업 현황'!A2:B3")
        assert request.url.params['valueInputOption'] == 'RAW'
        assert json.loads(request.content) == {'range': SHEET['range'], 'majorDimension': 'ROWS', 'values': SHEET['values']}
        assert request.headers['authorization'] == 'Bearer test-token-employee-a'
        return httpx.Response(200, json={'updatedCells': 4, 'updatedRange': SHEET['range']})
    mock_google(monkeypatch, handle)
    first = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    second = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    assert first == second
    assert first['saved'] is True and first['updated_cells'] == 4
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('override', [
    {'range': 'A1:B2'}, {'range': '영업!A:A'}, {'range': '영업!B3:A2'},
    {'range': '영업!A1:C1', 'values': [[1, 2]]}, {'values': [[1, 2]]},
    {'values': [[None, 1], [2, 3]]}, {'values': [[float('nan'), 1], [2, 3]]},
    {'values': [[{}, 1], [2, 3]]}, {'spreadsheet_id': '../other?key=token'},
    {'range': '영업!A1:A1001', 'values': [[1]] * 1001},
    {'range': '영업!A1:A1', 'values': [['x' * 5001]]},
])
async def test_sheet_invalid_bounds_rejected_before_network(google_tools, monkeypatch, override):
    def no_request(request): raise AssertionError('Invalid input must not call Google')
    mock_google(monkeypatch, no_request)
    result = await google_tools.call('update_sheet_range', {**SHEET, **override}, 'employee-a', 'thread', 'call')
    assert result['status'] == 400


@pytest.mark.asyncio
async def test_same_call_cannot_change_target_or_values_and_other_owner_is_independent(google_tools, monkeypatch):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={'updatedCells': 4})
    mock_google(monkeypatch, handle)
    first = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    changed = await google_tools.call('update_sheet_range', {**SHEET, 'spreadsheet_id': 'another_sheet'}, 'employee-a', 'thread', 'call')
    other = await google_tools.call('update_sheet_range', SHEET, 'employee-b', 'thread', 'call')
    assert changed['status'] == 409
    assert first['operation_id'] != other['operation_id']
    assert other['saved'] and len(calls) == 2


@pytest.mark.asyncio
async def test_sheet_timeout_can_verify_without_repeating_put(google_tools, monkeypatch):
    calls = []
    def handle(request):
        calls.append(request.method)
        if request.method == 'PUT': raise httpx.ReadTimeout('sensitive-network-error', request=request)
        assert request.url.params['valueRenderOption'] == 'UNFORMATTED_VALUE'
        return httpx.Response(200, json={'values': SHEET['values']})
    mock_google(monkeypatch, handle)
    result = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    assert result['saved'] is True and result['verified_after_retry'] is True
    assert calls == ['PUT', 'GET']
    assert 'sensitive-network-error' not in str(result)


@pytest.mark.asyncio
async def test_unknown_sheet_write_only_reads_on_later_retry(google_tools, monkeypatch):
    calls = []
    def handle(request):
        calls.append(request.method)
        if request.method == 'PUT': raise httpx.ReadTimeout('unknown', request=request)
        return httpx.Response(200, json={'values': [['old']]})
    mock_google(monkeypatch, handle)
    first = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    second = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    assert first['status'] == second['status'] == 503
    assert 'saved' not in second
    assert calls == ['PUT', 'GET', 'GET']


@pytest.mark.asyncio
async def test_calendar_creates_single_primary_event_with_stable_id(google_tools, monkeypatch):
    calls = []
    def handle(request):
        calls.append(request)
        assert request.method == 'POST' and request.url.path == '/calendar/v3/calendars/primary/events'
        assert request.url.params['sendUpdates'] == 'none'
        body = returned_event(request)
        assert re.fullmatch('[a-v0-9]{5,1024}', body['id'])
        assert 'attendees' not in body and 'recurrence' not in body
        return httpx.Response(200, json=body)
    mock_google(monkeypatch, handle)
    first = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    second = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    assert first == second and first['saved'] is True
    assert first['calendar_id'] == 'primary' and len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('override', [
    {'start_at': '2026-11-20T10:00:00'}, {'start_at': '2026-02-30T10:00:00+09:00'},
    {'end_at': '2026-11-20T09:00:00+09:00'}, {'end_at': '2026-11-20T10:00:00+09:00'},
    {'title': ''}, {'title': 'x' * 201}, {'description': 'x' * 10001},
])
async def test_calendar_requires_explicit_valid_times_and_bounded_text(google_tools, monkeypatch, override):
    def no_request(request): raise AssertionError('Invalid input must not call Google')
    mock_google(monkeypatch, no_request)
    result = await google_tools.call('create_calendar_event', {**EVENT, **override}, 'employee-a', 'thread', 'call')
    assert result['status'] == 400


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['timeout', 'conflict'])
async def test_calendar_timeout_or_conflict_verified_by_id_not_reposted(google_tools, monkeypatch, failure):
    calls = []; saved = {}
    def handle(request):
        calls.append(request.method)
        if request.method == 'POST':
            saved.update(returned_event(request))
            if failure == 'timeout': raise httpx.ReadTimeout('secret-request-token', request=request)
            return httpx.Response(409, json={'error': {'message': 'secret-request-token'}})
        assert request.url.path.endswith('/' + saved['id'])
        return httpx.Response(200, json=saved)
    mock_google(monkeypatch, handle)
    result = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    assert result['saved'] is True and result['verified_after_retry'] is True
    assert calls == ['POST', 'GET'] and 'secret-request-token' not in str(result)


@pytest.mark.asyncio
async def test_calendar_conflicting_event_is_not_claimed_as_success(google_tools, monkeypatch):
    calls = []; saved = {}
    def handle(request):
        calls.append(request.method)
        if request.method == 'POST':
            saved.update(returned_event(request)); return httpx.Response(409, json={})
        return httpx.Response(200, json={**saved, 'summary': 'another event'})
    mock_google(monkeypatch, handle)
    result = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    retry = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    assert result['status'] == retry['status'] == 503
    assert calls == ['POST', 'GET', 'GET']


@pytest.mark.asyncio
async def test_permission_denied_never_retries_or_exposes_response_body(google_tools, monkeypatch):
    calls = []
    def handle(request):
        calls.append(request.method)
        return httpx.Response(403, json={'error': {'message': 'private-token-data'}})
    mock_google(monkeypatch, handle)
    result = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    retry = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    assert result == retry and result['status'] == 403
    assert calls == ['POST'] and 'private-token-data' not in str(result)


@pytest.mark.asyncio
async def test_account_switch_during_refresh_stops_write(google_tools, monkeypatch):
    google_tools.providers.switch_on_token = True
    def no_request(request): raise AssertionError('Account switch must not write to either account')
    mock_google(monkeypatch, no_request)
    result = await google_tools.call('create_calendar_event', EVENT, 'employee-a', 'thread', 'call')
    assert result['status'] == 503


@pytest.mark.asyncio
async def test_disabled_connection_is_rejected_and_success_cannot_move_accounts(google_tools, monkeypatch):
    calls = []
    def handle(request): calls.append(request.method); return httpx.Response(200, json={'updatedCells': 4})
    mock_google(monkeypatch, handle)
    google_tools.providers.enabled = False
    disabled = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    assert disabled['status'] == 409 and calls == []
    google_tools.providers.enabled = True
    await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    google_tools.providers.subject = 'replacement-account'
    changed = await google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    assert changed['status'] == 409 and calls == ['PUT']


@pytest.mark.asyncio
async def test_two_workers_share_claim_and_issue_at_most_one_write(google_tools, monkeypatch):
    started = asyncio.Event(); release = asyncio.Event(); calls = []
    async def handle(request):
        calls.append(request.method)
        if request.method == 'PUT':
            started.set(); await release.wait(); return httpx.Response(200, json={'updatedCells': 4})
        return httpx.Response(200, json={'values': [['not yet']]})
    mock_google(monkeypatch, handle)
    first = asyncio.create_task(google_tools.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call'))
    await started.wait()
    other_worker = BusinessTools(google_tools.repo, google_tools.providers, None, None)
    second = await other_worker.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    release.set()
    result = await first
    assert second['status'] == 503 and result['saved'] is True
    assert calls.count('PUT') == 1
    replay = await other_worker.call('update_sheet_range', SHEET, 'employee-a', 'thread', 'call')
    assert replay['saved'] is True and calls.count('PUT') == 1
