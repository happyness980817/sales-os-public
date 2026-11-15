"""Owner-scoped persisted records; SQLite is explicit local development only."""
import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import httpx
from fastapi import HTTPException
from .config import Settings


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Repository:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = asyncio.Lock()
        self._http_client = None
        self.db = None
        if settings.dev_mode and not settings.supabase_service_key:
            Path(settings.database_path).parent.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(settings.database_path, check_same_thread=False)
            self.db.row_factory = sqlite3.Row
            self.db.executescript('''
                create table if not exists records(namespace text,id text,owner_id text,data text,revision integer,created_at text,updated_at text,primary key(namespace,id));
                create table if not exists members(id text primary key,data text);
            ''')

    def http_client(self):
        # Reuse the connection pool, never identity, credentials or query results.
        # Request-specific headers prevent one employee's bearer from leaking.
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=25)
        return self._http_client

    async def close(self):
        try:
            if self._http_client is not None:
                await self._http_client.aclose()
        finally:
            if self.db:
                self.db.close()

    async def request(self, method: str, path: str, *, params=None, data=None, headers=None):
        if not self.settings.supabase_service_key:
            raise HTTPException(503, '서버의 Supabase 연결 설정이 필요합니다.')
        key = self.settings.supabase_service_key
        base_headers = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}
        # New Supabase secret keys are accepted in apikey. They are not JWTs.
        if key.startswith('sb_secret_'):
            base_headers.pop('Authorization')
        base_headers.update(headers or {})
        try:
            res = await self.http_client().request(method, self.settings.supabase_url + '/rest/v1/' + path, params=params, json=data, headers=base_headers)
        except httpx.HTTPError:
            raise HTTPException(503, '데이터베이스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.') from None
        if res.status_code == 409:
            raise HTTPException(409, '이미 처리되었거나 동시에 변경된 항목입니다.')
        if res.status_code >= 400:
            raise HTTPException(503, '데이터베이스 설정 또는 마이그레이션을 확인해 주세요.')
        return res.json() if res.content else None

    @staticmethod
    def _decode(row):
        if row is None:
            return None
        result = dict(row)
        if isinstance(result['data'], str):
            result['data'] = json.loads(result['data'])
        return result

    async def get(self, namespace: str, id: str, owner: str | None = None):
        if self.db:
            row = self.db.execute('select * from records where namespace=? and id=?', (namespace, id)).fetchone()
            result = self._decode(row)
        else:
            params = {'namespace': f'eq.{namespace}', 'id': f'eq.{id}', 'limit': '1'}
            if owner is not None:
                params['owner_id'] = f'eq.{owner}'
            rows = await self.request('GET', 'salesos_records', params=params)
            result = rows[0] if rows else None
        if result and owner is not None and result['owner_id'] != owner:
            return None
        return result

    async def list(self, namespace: str, owner: str | None = None, limit=1000):
        if self.db:
            if owner is None:
                rows = self.db.execute('select * from records where namespace=? order by created_at desc limit ?', (namespace, limit)).fetchall()
            else:
                rows = self.db.execute('select * from records where namespace=? and owner_id=? order by created_at desc limit ?', (namespace, owner, limit)).fetchall()
            return [self._decode(row) for row in rows]
        # PostgREST applies a server page cap even when a larger limit is requested.
        # Fetch bounded pages rather than silently truncating older threads/items.
        output = []
        while len(output) < limit:
            size = min(500, limit - len(output))
            params = {'namespace': f'eq.{namespace}', 'order': 'created_at.desc,id.desc', 'limit': str(size), 'offset': str(len(output))}
            if owner is not None:
                params['owner_id'] = f'eq.{owner}'
            page = await self.request('GET', 'salesos_records', params=params)
            output.extend(page)
            if len(page) < size:
                break
        return output

    async def list_thread_items(self, owner: str, thread_id: str, limit=10000):
        """Filter before the bounded load used by ChatKit's existing cursor sorter."""
        if self.db:
            rows = self.db.execute(
                "select * from records where namespace='thread_items' and owner_id=? "
                "and json_extract(data,'$.thread_id')=? order by created_at desc,id desc limit ?",
                (owner, thread_id, limit),
            ).fetchall()
            return [self._decode(row) for row in rows]
        output = []
        while len(output) < limit:
            size = min(500, limit - len(output))
            page = await self.request('GET', 'salesos_records', params={
                'namespace': 'eq.thread_items', 'owner_id': f'eq.{owner}',
                'data': 'cs.' + json.dumps({'thread_id': thread_id}),
                'order': 'created_at.desc,id.desc', 'limit': str(size), 'offset': str(len(output)),
            })
            output.extend(page)
            if len(page) < size:
                break
        return output

    async def list_projects_page(self, owner: str, *, limit: int, after=None):
        if self.db:
            query = "select * from records where namespace='projects' and owner_id=?"
            values = [owner]
            if after:
                query += ' and (created_at < ? or (created_at = ? and id < ?))'
                values.extend([after['created_at'], after['created_at'], after['id']])
            rows = self.db.execute(query + ' order by created_at desc,id desc limit ?', (*values, limit)).fetchall()
            return [self._decode(row) for row in rows]
        params = {'namespace': 'eq.projects', 'owner_id': f'eq.{owner}',
                  'order': 'created_at.desc,id.desc', 'limit': str(limit)}
        if after:
            # Cursor values come from an owned record. Quote filter literals so
            # commas/parentheses cannot change PostgREST's filter expression.
            stamp, id = json.dumps(after['created_at']), json.dumps(after['id'])
            params['or'] = f'(created_at.lt.{stamp},and(created_at.eq.{stamp},id.lt.{id}))'
        return await self.request('GET', 'salesos_records', params=params)

    async def list_threads(self, owner: str, *, scoped=False, project_id=None, limit=10000):
        """Apply project ownership filtering before the bounded ChatKit scan."""
        if self.db:
            query = "select * from records where namespace='threads' and owner_id=?"
            values = [owner]
            if scoped:
                if project_id is None:
                    query += " and json_extract(data,'$.metadata.project_id') is null"
                else:
                    query += " and json_extract(data,'$.metadata.project_id')=?"
                    values.append(project_id)
            rows = self.db.execute(query + ' order by created_at desc,id desc limit ?', (*values, limit)).fetchall()
            return [self._decode(row) for row in rows]
        output = []
        while len(output) < limit:
            size = min(500, limit - len(output))
            params = {'namespace': 'eq.threads', 'owner_id': f'eq.{owner}',
                      'order': 'created_at.desc,id.desc', 'limit': str(size), 'offset': str(len(output))}
            if scoped:
                params['data->metadata->>project_id'] = 'is.null' if project_id is None else f'eq.{project_id}'
            page = await self.request('GET', 'salesos_records', params=params)
            output.extend(page)
            if len(page) < size:
                break
        return output

    async def delete_thread_items(self, owner: str, thread_id: str):
        """Delete all matching items, including those outside the listing limit."""
        if self.db:
            async with self.lock:
                with self.db:
                    self.db.execute(
                        "delete from records where namespace='thread_items' and owner_id=? "
                        "and json_extract(data,'$.thread_id')=?", (owner, thread_id),
                    )
        else:
            await self.request('DELETE', 'salesos_records', params={
                'namespace': 'eq.thread_items', 'owner_id': f'eq.{owner}',
                'data': 'cs.' + json.dumps({'thread_id': thread_id}),
            })

    async def list_upload_metadata(self, owner: str, *, limit: int, offset: int):
        """Page actual chat uploads only; never fetch file contents or preview capabilities."""
        if self.db:
            rows = self.db.execute(
                "select id,json_extract(data,'$.name') as name,created_at from records "
                "where namespace='attachments' and owner_id=? "
                "order by created_at desc,id desc limit ? offset ?",
                (owner, limit, offset),
            ).fetchall()
            return [dict(row) for row in rows]
        return await self.request('GET', 'salesos_records', params={
            'namespace': 'eq.attachments', 'owner_id': f'eq.{owner}',
            'select': 'id,name:data->>name,created_at',
            'order': 'created_at.desc,id.desc', 'limit': str(limit), 'offset': str(offset),
        })

    async def insert(self, namespace: str, id: str, owner: str, data: dict):
        stamp = now()
        row = {'namespace': namespace, 'id': id, 'owner_id': owner, 'data': data, 'revision': 1, 'created_at': stamp, 'updated_at': stamp}
        if self.db:
            async with self.lock:
                try:
                    self.db.execute('insert into records values(?,?,?,?,?,?,?)', (namespace, id, owner, json.dumps(data, ensure_ascii=False), 1, stamp, stamp))
                    self.db.commit()
                except sqlite3.IntegrityError:
                    self.db.rollback()
                    raise HTTPException(409, '이미 처리된 항목입니다.') from None
            return row
        return (await self.request('POST', 'salesos_records', data=row, headers={'Prefer': 'return=representation'}))[0]

    async def cas(self, row, data: dict):
        if self.db:
            async with self.lock:
                updated = self.db.execute('update records set data=?,revision=revision+1,updated_at=? where namespace=? and id=? and owner_id=? and revision=?',
                    (json.dumps(data, ensure_ascii=False), now(), row['namespace'], row['id'], row['owner_id'], row['revision']))
                self.db.commit()
                if updated.rowcount != 1:
                    return None
            return await self.get(row['namespace'], row['id'], row['owner_id'])
        rows = await self.request('POST', 'rpc/salesos_cas_record', data={
            'p_namespace': row['namespace'], 'p_id': row['id'], 'p_owner_id': row['owner_id'], 'p_revision': row['revision'], 'p_data': data})
        return rows[0] if rows else None

    async def save(self, namespace: str, id: str, owner: str, data: dict):
        row = await self.get(namespace, id)
        if row:
            if row['owner_id'] != owner:
                raise HTTPException(404, '항목을 찾을 수 없습니다.')
            result = await self.cas(row, data)
            if result is None:
                raise HTTPException(409, '다른 요청으로 변경되었습니다. 다시 시도해 주세요.')
            return result
        return await self.insert(namespace, id, owner, data)

    async def delete(self, namespace: str, id: str, owner: str):
        if self.db:
            self.db.execute('delete from records where namespace=? and id=? and owner_id=?', (namespace, id, owner))
            self.db.commit()
        else:
            await self.request('DELETE', 'salesos_records', params={'namespace': f'eq.{namespace}', 'id': f'eq.{id}', 'owner_id': f'eq.{owner}'})

    async def member(self, auth_id: str):
        if self.db:
            row = self.db.execute('select data from members where id=?', (auth_id,)).fetchone()
            return json.loads(row['data']) if row else None
        rows = await self.request('GET', 'salesos_members', params={'auth_user_id': f'eq.{auth_id}', 'limit': '1'})
        return rows[0] if rows else None

    async def create_member(self, member: dict):
        if self.db:
            self.db.execute('insert or ignore into members values(?,?)', (member['id'], json.dumps(member)))
            self.db.commit()
            return member
        try:
            return (await self.request('POST', 'salesos_members', data=member, headers={'Prefer': 'return=representation'}))[0]
        except HTTPException as exc:
            if exc.status_code == 409:
                return await self.member(member['auth_user_id'])
            raise

    def _local_record(self, namespace, id):
        return self._decode(self.db.execute('select * from records where namespace=? and id=?', (namespace, id)).fetchone())

    def _local_put(self, namespace, id, owner, data, *, preserve=False):
        existing = self._local_record(namespace, id)
        if existing and existing['owner_id'] != owner:
            raise HTTPException(409, '다른 계정에 속한 항목입니다.')
        if existing and preserve: return existing
        stamp = now()
        if existing:
            self.db.execute('update records set data=?,revision=revision+1,updated_at=? where namespace=? and id=?',
                            (json.dumps(data, ensure_ascii=False), stamp, namespace, id))
        else:
            self.db.execute('insert into records values(?,?,?,?,?,?,?)',
                            (namespace, id, owner, json.dumps(data, ensure_ascii=False), 1, stamp, stamp))
        return self._local_record(namespace, id)

    @staticmethod
    def _lease_live(value):
        try: return datetime.fromisoformat(value) > datetime.now(timezone.utc)
        except (ValueError, TypeError): return False

    async def ingest_line_message(self, key, owner, event_data, job_data):
        if not self.db:
            return await self.request('POST', 'rpc/salesos_ingest_line_message', data={
                'p_key': key, 'p_owner_id': owner, 'p_event_data': event_data, 'p_job_data': job_data})
        async with self.lock:
            with self.db:
                self.db.execute('begin immediate')
                event = self._local_record('line_events', key)
                job = self._local_record('jobs', 'line_' + key)
                if event and (event['owner_id'] != owner or event['data'].get('type') != 'message'):
                    raise HTTPException(409, 'LINE 이벤트 소유자가 일치하지 않습니다.')
                if job and (job['owner_id'] != owner or job['data'].get('kind') != 'line_chat'):
                    raise HTTPException(409, 'LINE 작업 소유자가 일치하지 않습니다.')
                self._local_put('line_events', key, owner, event_data, preserve=True)
                self._local_put('jobs', 'line_' + key, owner, job_data, preserve=True)
                return job is None

    async def link_line_account(self, key, owner, line_user_key, line_user_id, code_row, outbound_id, outbound_data):
        args = {'p_key': key, 'p_owner_id': owner, 'p_line_user_key': line_user_key, 'p_line_user_id': line_user_id,
                'p_code_id': code_row['id'], 'p_code_revision': code_row['revision'],
                'p_outbound_id': outbound_id, 'p_outbound_data': outbound_data}
        if not self.db:
            return await self.request('POST', 'rpc/salesos_link_line_account', data=args)
        async with self.lock:
            with self.db:
                self.db.execute('begin immediate')
                event = self._local_record('line_events', key)
                if event:
                    if event['owner_id'] != owner or event['data'].get('type') != 'link':
                        raise HTTPException(409, 'LINE 이벤트 소유자가 일치하지 않습니다.')
                    return False
                member = self.db.execute('select data from members where id=?', (owner,)).fetchone()
                code = self._local_record('line_codes', code_row['id'])
                mapping = self._local_record('line_users', line_user_key)
                if not member or not json.loads(member['data']).get('active'): return False
                if not code or code['owner_id'] != owner or code['revision'] != code_row['revision'] or code['data'].get('consumed') or not self._lease_live(code['data'].get('expires_at')): return False
                if mapping and mapping['owner_id'] != owner: return False
                self._local_put('line_codes', code['id'], owner, {**code['data'], 'consumed': True})
                self.db.execute("delete from records where namespace='line_users' and owner_id=? and id<>?", (owner, line_user_key))
                stamp = now()
                self._local_put('line_users', line_user_key, owner, {'linked_at': stamp})
                self._local_put('line_links', owner, owner, {'user_id': line_user_id, 'active': True, 'linked_at': stamp})
                self._local_put('connections', owner + ':line', owner, {'connected': True, 'enabled': True, 'account': '내 LINE', 'updated_at': stamp})
                self._local_put('line_events', key, owner, {'processed_at': stamp, 'type': 'link'})
                self._local_put('line_outbound', outbound_id, owner, outbound_data, preserve=True)
                return True

    async def claim_worker_job(self, lease_token, lease_seconds=120):
        if not self.db:
            rows = await self.request('POST', 'rpc/salesos_claim_worker_job', data={
                'p_lease_token': lease_token, 'p_lease_seconds': lease_seconds})
            return rows[0] if rows else None
        async with self.lock:
            with self.db:
                self.db.execute('begin immediate')
                rows = [self._decode(row) for row in self.db.execute("select * from records where namespace='jobs' order by created_at,id").fetchall()]
                for row in rows:
                    data = row['data']
                    if data.get('kind') not in ('line_chat', 'notion_contact') or data.get('status') not in ('pending', 'processing'): continue
                    if data['status'] == 'processing' and self._lease_live(data.get('lease_until')): continue
                    if any(other['id'] != row['id'] and other['owner_id'] == row['owner_id'] and other['data'].get('kind') in ('line_chat', 'notion_contact') and other['data'].get('status') == 'processing' and self._lease_live(other['data'].get('lease_until')) for other in rows): continue
                    return self._local_put('jobs', row['id'], row['owner_id'], {**data, 'status': 'processing',
                        'lease_token': lease_token, 'lease_until': (datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)).isoformat(),
                        'attempts': data.get('attempts', 0) + 1, 'recovery': data['status'] == 'processing', 'updated_at': now()})
                return None

    async def finish_worker_job(self, row, status, *, error=None, outbound_id=None, outbound_data=None):
        if status not in ('succeeded', 'failed', 'cancelled'): raise ValueError('Invalid final job status')
        args = {'p_id': row['id'], 'p_owner_id': row['owner_id'], 'p_lease_token': row['data']['lease_token'],
                'p_status': status, 'p_error': error, 'p_outbound_id': outbound_id, 'p_outbound_data': outbound_data}
        if not self.db:
            rows = await self.request('POST', 'rpc/salesos_finish_worker_job', data=args)
            return rows[0] if rows else None
        async with self.lock:
            with self.db:
                self.db.execute('begin immediate')
                current = self._local_record('jobs', row['id'])
                if not current or current['owner_id'] != row['owner_id'] or current['data'].get('status') != 'processing' or current['data'].get('lease_token') != args['p_lease_token'] or not self._lease_live(current['data'].get('lease_until')): return None
                if outbound_id and outbound_data:
                    self._local_put('line_outbound', outbound_id, row['owner_id'], outbound_data, preserve=True)
                data = {**current['data'], 'status': status, 'updated_at': now(), 'error': error}
                data.pop('lease_token', None); data.pop('lease_until', None)
                return self._local_put('jobs', row['id'], row['owner_id'], data)

    async def claim_line_inbox(self, id):
        rows = await self.request('POST', 'rpc/salesos_claim_line_inbox', data={'p_id': id, 'p_lease_seconds': 120})
        return rows[0] if rows else None

    async def line_inbox_status(self, id):
        rows = await self.request('GET', 'salesos_line_inbox', params={'id': f'eq.{id}', 'select': 'id,status', 'limit': '1'})
        return rows[0] if rows else None

    async def finish_line_inbox(self, row, success, *, error=None, retryable=True):
        return await self.request('POST', 'rpc/salesos_finish_line_inbox', data={'p_id': row['id'],
            'p_lease_token': row['lease_token'], 'p_success': success, 'p_error': error, 'p_retryable': retryable})
