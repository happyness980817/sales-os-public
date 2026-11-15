import asyncio

import pytest
from fastapi import HTTPException

from salesos_api.security import DEV_USER_ID
from salesos_api.tools import BusinessTools


CASES = [('create_task', {'title': '미팅 준비'}, 'tasks'),
         ('save_contact', {'name': '테스트 담당자', 'email': 'sample@example.test'}, 'contacts')]


@pytest.mark.asyncio
@pytest.mark.parametrize('name,payload,namespace', CASES)
async def test_concurrent_chatkit_tool_retries_create_one_record_and_one_notion_job(app, monkeypatch, name, payload, namespace):
    owner = DEV_USER_ID
    await app.state.repo.save('settings', owner + ':notion_contacts', owner, {'page_id': 'a' * 32})
    started, release = asyncio.Event(), asyncio.Event()
    original = app.state.repo.insert
    async def hold_record(kind, id, user, data):
        if kind == namespace:
            started.set()
            await release.wait()
        return await original(kind, id, user, data)
    monkeypatch.setattr(app.state.repo, 'insert', hold_record)
    tools = BusinessTools(app.state.repo, None, None, None)
    another_worker = BusinessTools(app.state.repo, None, None, None)
    first = asyncio.create_task(tools.call(name, payload, owner, 'thread', 'call'))
    await asyncio.wait_for(started.wait(), 2)
    try:
        other = await another_worker.call(name, payload, owner, 'thread', 'call')
        assert other['status'] == 409 and other['operation_status'] == 'processing'
    finally:
        release.set()
    result = await first
    assert result['saved'] is True
    assert await another_worker.call(name, payload, owner, 'thread', 'call') == result
    assert len(await app.state.repo.list(namespace, owner)) == 1
    assert len(await app.state.repo.list('tool_actions', owner)) == 1
    jobs = await app.state.repo.list('jobs', owner)
    assert len(jobs) == (1 if name == 'save_contact' else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize('name,payload,namespace', CASES)
async def test_same_request_changed_payload_rejected_and_other_owner_is_independent(app, name, payload, namespace):
    tools = BusinessTools(app.state.repo, None, None, None)
    first = await tools.call(name, payload, 'employee-a', 'thread', 'call')
    assert first['saved'] is True
    key = 'title' if name == 'create_task' else 'name'
    changed = await tools.call(name, {**payload, key: '다른 내용'}, 'employee-a', 'thread', 'call')
    assert changed['status'] == 409
    other = await tools.call(name, payload, 'employee-b', 'thread', 'call')
    assert other['saved'] is True and first['id'] != other['id']
    assert len(await app.state.repo.list(namespace, 'employee-a')) == 1
    assert len(await app.state.repo.list(namespace, 'employee-b')) == 1


@pytest.mark.asyncio
async def test_lost_contact_write_response_stays_unknown_without_duplicate_or_new_job(app, monkeypatch):
    repo = app.state.repo
    await repo.save('settings', 'employee-a:notion_contacts', 'employee-a', {'page_id': 'a' * 32})
    original = repo.insert
    calls = 0
    async def lost_response(namespace, id, owner, data):
        nonlocal calls
        result = await original(namespace, id, owner, data)
        if namespace == 'jobs':
            calls += 1
            raise HTTPException(503, 'synthetic lost response')
        return result
    monkeypatch.setattr(repo, 'insert', lost_response)
    tools = BusinessTools(repo, None, None, None)
    args = {'name': '테스트 담당자'}
    first = await tools.call('save_contact', args, 'employee-a', 'thread', 'call')
    repeated = await tools.call('save_contact', args, 'employee-a', 'thread', 'call')
    assert first == repeated and first['status'] == 503 and first['operation_status'] == 'unknown'
    assert 'saved' not in first
    assert len(await repo.list('contacts', 'employee-a')) == 1
    assert len(await repo.list('jobs', 'employee-a')) == 1 and calls == 1


@pytest.mark.asyncio
async def test_lost_completion_response_recovers_committed_success(app, monkeypatch):
    repo = app.state.repo
    original = repo.cas
    async def lost_success(row, data):
        result = await original(row, data)
        if row['namespace'] == 'tool_actions' and data.get('status') == 'succeeded':
            raise HTTPException(503, 'synthetic lost completion response')
        return result
    monkeypatch.setattr(repo, 'cas', lost_success)
    tools = BusinessTools(repo, None, None, None)
    args = {'title': '미팅 준비'}
    first = await tools.call('create_task', args, 'employee-a', 'thread', 'call')
    assert first['saved'] is True
    assert await tools.call('create_task', args, 'employee-a', 'thread', 'call') == first
    assert len(await repo.list('tasks', 'employee-a')) == 1


@pytest.mark.asyncio
async def test_existing_chatkit_success_is_compatible_but_not_reused_for_changed_input(app):
    repo = app.state.repo
    result = {'id': 'old-task', 'saved': True, 'title': '미팅 준비', 'description': '', 'due_at': None,
              'status': 'pending', 'created_at': '2026-11-15T00:00:00Z'}
    await repo.save('tool_actions', 'thread:call', 'employee-a', {'name': 'create_task', 'result': result})
    tools = BusinessTools(repo, None, None, None)
    assert await tools.call('create_task', {'title': '미팅 준비'}, 'employee-a', 'thread', 'call') == result
    changed = await tools.call('create_task', {'title': '다른 요청'}, 'employee-a', 'thread', 'call')
    assert changed['status'] == 409
    assert await repo.list('tasks', 'employee-a') == []


@pytest.mark.asyncio
async def test_cross_tool_reuse_of_chatkit_call_id_does_not_create_second_operation(app):
    tools = BusinessTools(app.state.repo, None, None, None)
    await tools.call('create_task', {'title': '미팅 준비'}, 'employee-a', 'thread', 'call')
    other = await tools.call('save_contact', {'name': '담당자'}, 'employee-a', 'thread', 'call')
    assert other['status'] == 409
    assert await app.state.repo.list('contacts', 'employee-a') == []
