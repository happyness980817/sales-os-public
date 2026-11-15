import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from chatkit.store import NotFoundError
from chatkit.types import AssistantMessageItem, ThreadMetadata, UserMessageInput

from salesos_api.chat import ChatStore
from salesos_api.config import Settings
from salesos_api.repository import Repository


def context(owner='owner-a'):
    return {'member': {'id': owner}}


async def add_thread(store, id='thr_a', owner='owner-a'):
    await store.save_thread(ThreadMetadata(id=id, created_at=datetime.fromisoformat('2026-11-01T00:00:00+00:00')),
                            context(owner))


async def add_message(store, id, stamp, thread_id='thr_a', owner='owner-a'):
    await store.save_item(thread_id, AssistantMessageItem(
        id=id, thread_id=thread_id, created_at=datetime.fromisoformat(stamp), content=[]), context(owner))


@pytest.mark.asyncio
@pytest.mark.parametrize('order,expected', [('asc', ['msg_a', 'msg_b', 'msg_c']),
                                           ('desc', ['msg_c', 'msg_b', 'msg_a'])])
async def test_item_cursor_preserves_timezones_ties_and_isolation(app, order, expected):
    store = ChatStore(app.state.repo)
    await add_thread(store)
    await add_thread(store, 'thr_other')
    await add_thread(store, 'thr_private', 'owner-b')
    await add_message(store, 'msg_a', '2026-11-01T00:00:00+00:00')
    await add_message(store, 'msg_b', '2026-11-01T09:00:00+09:00')
    await add_message(store, 'msg_c', '2026-11-01T00:01:00+00:00')
    await add_message(store, 'msg_other', '2026-12-01T00:00:00+00:00', 'thr_other')
    await add_message(store, 'msg_private', '2026-12-01T00:00:00+00:00', 'thr_private', 'owner-b')
    # A record with the same payload thread ID still belongs only to its verified owner.
    await app.state.repo.insert('thread_items', 'msg_foreign', 'owner-b', {
        'type': 'assistant_message', 'id': 'msg_foreign', 'thread_id': 'thr_a',
        'created_at': '2026-12-01T00:00:00Z', 'content': [],
    })

    first = await store.load_thread_items('thr_a', None, 2, order, context())
    assert [item.id for item in first.data] == expected[:2]
    assert first.has_more and first.after == expected[1]
    last = await store.load_thread_items('thr_a', first.after, 2, order, context())
    assert [item.id for item in last.data] == expected[2:]
    assert not last.has_more and last.after is None
    empty = await store.load_thread_items('thr_a', expected[-1], 2, order, context())
    assert empty.data == [] and not empty.has_more and empty.after is None
    for cursor in ['missing', 'msg_other', 'msg_private', 'msg_foreign']:
        with pytest.raises(NotFoundError):
            await store.load_thread_items('thr_a', cursor, 2, order, context())
    with pytest.raises(NotFoundError):
        await store.load_thread_items('thr_private', None, 2, order, context())
    with pytest.raises(NotFoundError):
        await store.delete_thread('thr_private', context())
    assert (await store.load_item('thr_private', 'msg_private', context('owner-b'))).id == 'msg_private'


@pytest.mark.asyncio
async def test_other_threads_do_not_hide_items_and_bulk_delete_has_no_listing_cap(app):
    repo = app.state.repo
    store = ChatStore(repo)
    await add_thread(store)
    await add_thread(store, 'thr_other')
    await add_message(store, 'msg_target', '2026-11-01T00:00:00+00:00')
    repo.db.execute("update records set created_at='2026-11-01' where id='msg_target'")
    # Previously these newer records exhausted the global 10,000-record scan.
    repo.db.executemany('insert into records values(?,?,?,?,?,?,?)', [
        ('thread_items', f'unrelated_{i}', 'owner-a', json.dumps({'thread_id': 'thr_other'}),
         1, '2026-12-01', '2026-12-01') for i in range(10001)
    ])
    repo.db.commit()
    page = await store.load_thread_items('thr_a', None, 10, 'desc', context())
    assert [item.id for item in page.data] == ['msg_target']

    repo.db.executemany('insert into records values(?,?,?,?,?,?,?)', [
        ('thread_items', f'target_{i}', 'owner-a', json.dumps({'thread_id': 'thr_a'}),
         1, '2026-12-01', '2026-12-01') for i in range(10001)
    ])
    repo.db.commit()
    await repo.insert('thread_items', 'foreign', 'owner-b', {'thread_id': 'thr_a'})
    await repo.insert('jobs', 'unrelated_namespace', 'owner-a', {'thread_id': 'thr_a'})
    await store.delete_thread('thr_a', context())
    assert await repo.get('threads', 'thr_a', 'owner-a') is None
    assert await repo.list_thread_items('owner-a', 'thr_a') == []
    assert repo.db.execute("select count(*) from records where namespace='thread_items' and owner_id='owner-a'").fetchone()[0] == 10001
    assert await repo.get('thread_items', 'foreign', 'owner-b') is not None
    assert await repo.get('jobs', 'unrelated_namespace', 'owner-a') is not None
    assert await repo.get('threads', 'thr_other', 'owner-a') is not None


@pytest.mark.asyncio
async def test_supabase_filters_each_page_and_deletes_all_matching_items(monkeypatch):
    repo = Repository(Settings(_env_file=None, dev_mode=False,
                              supabase_url='https://fixture.supabase.co', supabase_service_key='fixture-service-key'))
    # Exercise JSON escaping and URL encoding as well as owner/namespace filters.
    thread_id = 'thr_"quoted,part).한글'
    rows = [{'namespace': 'thread_items', 'owner_id': 'owner-a', 'id': f'msg_{i}',
             'data': {'thread_id': thread_id}} for i in range(501)]
    keep = [
        {'namespace': 'thread_items', 'owner_id': 'owner-b', 'id': 'foreign', 'data': {'thread_id': thread_id}},
        {'namespace': 'thread_items', 'owner_id': 'owner-a', 'id': 'other', 'data': {'thread_id': 'thr_other'}},
        {'namespace': 'jobs', 'owner_id': 'owner-a', 'id': 'job', 'data': {'thread_id': thread_id}},
    ]
    rows.extend(keep)
    calls = []

    def handle(request):
        assert request.url.path == '/rest/v1/salesos_records'
        query = request.url.params
        assert query['namespace'] == 'eq.thread_items'
        assert query['owner_id'] == 'eq.owner-a'
        assert query['data'].startswith('cs.')
        assert json.loads(query['data'][3:]) == {'thread_id': thread_id}
        matching = [row for row in rows if row['namespace'] == 'thread_items'
                    and row['owner_id'] == 'owner-a' and row['data']['thread_id'] == thread_id]
        calls.append((request.method, dict(query)))
        if request.method == 'DELETE':
            assert 'limit' not in query and 'offset' not in query
            rows[:] = [row for row in rows if row not in matching]
            return httpx.Response(204)
        assert request.method == 'GET'
        assert query['order'] == 'created_at.desc,id.desc'
        offset, limit = int(query['offset']), int(query['limit'])
        return httpx.Response(200, json=matching[offset:offset + limit])

    original_client = httpx.AsyncClient
    monkeypatch.setattr('salesos_api.repository.httpx.AsyncClient',
                        lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(handle)))
    result = await repo.list_thread_items('owner-a', thread_id)
    assert [row['id'] for row in result] == [f'msg_{i}' for i in range(501)]
    assert [query['offset'] for method, query in calls] == ['0', '500']
    await repo.delete_thread_items('owner-a', thread_id)
    assert rows == keep
    assert [method for method, query in calls] == ['GET', 'GET', 'DELETE']


class KstSdkDatetime(datetime):
    """Exercise the SDK's naive server-local clock independently of the test OS."""
    @classmethod
    def now(cls, tz=None):
        local = cls(2026, 11, 1, 9, 0, 0)
        return local if tz is None else local.astimezone(tz)

    def astimezone(self, tz=None):
        value = self if self.tzinfo else self.replace(tzinfo=timezone(timedelta(hours=9)))
        return datetime.astimezone(value, tz)


@pytest.mark.asyncio
async def test_sdk_naive_local_user_and_utc_assistant_reopen_in_order(app, monkeypatch):
    monkeypatch.setattr('chatkit.server.datetime', KstSdkDatetime)
    chat, repo = app.state.chat, app.state.repo
    value = ThreadMetadata(id='thr_kst', created_at=KstSdkDatetime.now())
    await chat.store.save_thread(value, context())
    user = await chat._build_user_message_item(UserMessageInput(
        content=[{'type': 'input_text', 'text': '새 대화'}], attachments=[], inference_options={}), value, context())
    assert user.created_at.tzinfo is None  # The installed SDK produces naive local time.
    await chat.store.add_thread_item(value.id, user, context())
    await add_message(chat.store, 'msg_answer', '2026-11-01T00:00:01Z', value.id)
    expected = datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert value.created_at == user.created_at == expected
    assert (await repo.get('thread_items', user.id))['data']['created_at'] == '2026-11-01T00:00:00Z'
    reopened = await chat._load_full_thread(value.id, context())
    assert [item.type for item in reopened.items.data] == ['user_message', 'assistant_message']
    assert all(item.created_at.utcoffset() == timedelta(0) for item in reopened.items.data)
    assert reopened.created_at == expected


@pytest.mark.asyncio
@pytest.mark.parametrize('order,expected', [('asc', ['user_1', 'answer_1', 'user_2', 'answer_2']),
                                           ('desc', ['answer_2', 'user_2', 'answer_1', 'user_1'])])
async def test_legacy_naive_records_use_insert_time_without_rewriting_and_preserve_cursors(app, order, expected):
    repo, store = app.state.repo, app.state.chat.store
    # Legacy data could have been written in KST, UTC, or a previous server zone.
    # Only its independent first-insert UTC timestamp has an unambiguous meaning.
    await repo.insert('threads', 'thr_legacy', 'owner-a', {
        'id': 'thr_legacy', 'created_at': '2026-11-01T09:00:00', 'metadata': {}})
    repo.db.execute("update records set created_at='2026-11-01T00:00:00Z' where namespace='threads' and id='thr_legacy'")
    for id, payload_stamp, insert_stamp in [
        ('user_1', '2026-11-01T09:00:00', '2026-11-01T00:00:00Z'),
        ('answer_1', '2026-11-01T00:01:00Z', '2026-11-01T00:01:05Z'),
        ('user_2', '2026-11-01T09:02:00', '2026-11-01T00:02:00Z'),
        ('answer_2', '2026-11-01T09:03:00+09:00', '2026-11-01T00:03:05Z'),
    ]:
        payload = {'type': 'user_message' if id.startswith('user') else 'assistant_message',
                   'id': id, 'thread_id': 'thr_legacy', 'created_at': payload_stamp, 'content': []}
        if id.startswith('user'):
            payload.update(attachments=[], inference_options={})
        await repo.insert('thread_items', id, 'owner-a', payload)
        repo.db.execute("update records set created_at=? where namespace='thread_items' and id=?", (insert_stamp, id))
    repo.db.commit()
    before = repo.db.execute('select * from records order by namespace,id').fetchall()
    first = await store.load_thread_items('thr_legacy', None, 2, order, context())
    assert [item.id for item in first.data] == expected[:2]
    assert first.has_more and first.after == expected[1]
    last = await store.load_thread_items('thr_legacy', first.after, 2, order, context())
    assert [item.id for item in last.data] == expected[2:]
    assert not last.has_more and last.after is None
    assert (await store.load_item('thr_legacy', 'user_1', context())).created_at == datetime(2026, 11, 1, tzinfo=timezone.utc)
    # An aware payload keeps its actual creation time, not the later DB insert.
    assert (await store.load_item('thr_legacy', 'answer_1', context())).created_at.minute == 1
    assert (await store.load_item('thr_legacy', 'answer_1', context())).created_at.second == 0
    reopened = await app.state.chat._load_full_thread('thr_legacy', context())
    assert [item.id for item in reopened.items.data] == ['user_1', 'answer_1', 'user_2', 'answer_2']
    threads = await store.load_threads(10, None, 'asc', context())
    assert reopened.created_at == threads.data[0].created_at == datetime(2026, 11, 1, tzinfo=timezone.utc)
    assert repo.db.execute('select * from records order by namespace,id').fetchall() == before
