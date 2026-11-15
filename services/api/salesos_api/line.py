import asyncio
import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid4, uuid5
from fastapi import HTTPException
from .security import digest, expires, is_expired
from .repository import now


class LineBridge:
    """Verified LINE ingress and an outbox; n8n transports the outbound requests."""
    def __init__(self, settings, repo, security, chat, providers):
        self.settings, self.repo, self.security, self.chat, self.providers = settings, repo, security, chat, providers
        self.lock = asyncio.Lock()

    async def link_code(self, owner):
        if not self.settings.line_ready:
            raise HTTPException(503, 'LINE 공식 계정과 자동화 연결을 관리자가 먼저 설정해야 합니다.')
        code = secrets.token_hex(5).upper()
        expiry = expires(10)
        await self.repo.insert('line_codes', digest(code), owner, {'expires_at': expiry, 'consumed': False})
        return {'code': code, 'expires_at': expiry, 'message': f'LINE 공식 계정에 연결 {code} 를 보내 주세요.'}

    async def disconnect(self, owner):
        row = await self.repo.get('line_links', owner, owner)
        if row:
            await self.repo.cas(row, {**row['data'], 'active': False})
        await self.providers.disconnect(owner, 'line')
        return {'ok': True}

    async def enqueue(self, owner, event_id, text):
        link = await self.repo.get('line_links', owner, owner)
        if not link or not link['data'].get('active'):
            return
        key = digest(event_id + ':outbound')
        if await self.repo.get('line_outbound', key, owner):
            return
        # LINE retries use a stable retry key. More than 5 messages is clipped explicitly.
        chunks = [text[i:i + 4500] for i in range(0, len(text), 4500)][:5] or ['응답을 확인하지 못했습니다. 웹에서 작업 상태를 확인해 주세요.']
        if len(text) > 22500:
            chunks[-1] = chunks[-1][:4400] + '\n전체 내용은 웹 대화에서 확인해 주세요.'
        await self.repo.insert('line_outbound', key, owner, {
            'status': 'pending', 'to': link['data']['user_id'],
            'messages': [{'type': 'text', 'text': c} for c in chunks],
            'retry_key': str(uuid5(NAMESPACE_URL, key)), 'attempts': 0, 'created_at': now(), 'updated_at': now(),
        })

    async def ingest(self, raw, signature):
        if not self.settings.line_channel_secret:
            raise HTTPException(503, 'LINE 서명 검증 설정이 없습니다.')
        expected = base64.b64encode(hmac.new(self.settings.line_channel_secret.encode(), raw, hashlib.sha256).digest()).decode()
        if not signature or not hmac.compare_digest(signature, expected):
            raise HTTPException(401, 'LINE 서명을 확인하지 못했습니다.')
        try:
            payload = json.loads(raw)
            events = payload['events']
            if not isinstance(events, list) or len(events) > 100: raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, 'LINE 이벤트 형식이 올바르지 않습니다.') from None
        accepted = duplicates = ignored = 0
        for event in events:
            source = event.get('source', {})
            # Personal assistants never expose employee data to group or room conversations.
            if source.get('type') != 'user' or not source.get('userId'):
                ignored += 1; continue
            line_user = source['userId']
            event_id = event.get('webhookEventId')
            if not isinstance(event_id, str) or len(event_id) > 200:
                ignored += 1; continue
            key = digest(event_id)
            if await self.repo.get('line_events', key):
                duplicates += 1; continue
            message = event.get('message', {})
            text = message.get('text', '') if message.get('type') == 'text' else ''
            mapping = await self.repo.get('line_users', digest(line_user))
            owner = mapping['owner_id'] if mapping else None
            if text.startswith('연결 '):
                code = text[3:].strip().upper()
                row = await self.repo.get('line_codes', digest(code))
                if not row or row['data'].get('consumed') or is_expired(row['data']['expires_at']):
                    ignored += 1; continue
                if mapping and mapping['owner_id'] != row['owner_id']:
                    ignored += 1; continue
                member = await self.repo.member(row['owner_id'])
                if not member or not member.get('active'):
                    ignored += 1; continue
                if not await self.repo.cas(row, {**row['data'], 'consumed': True}):
                    duplicates += 1; continue
                owner = row['owner_id']
                previous = await self.repo.get('line_links', owner, owner)
                if previous and previous['data']['user_id'] != line_user:
                    await self.repo.delete('line_users', digest(previous['data']['user_id']), owner)
                await self.repo.save('line_users', digest(line_user), owner, {'linked_at': now()})
                await self.repo.save('line_links', owner, owner, {'user_id': line_user, 'active': True, 'linked_at': now()})
                await self.repo.save('connections', f'{owner}:line', owner, {'connected': True, 'enabled': True, 'account': '내 LINE', 'updated_at': now()})
                await self.repo.insert('line_events', key, owner, {'processed_at': now(), 'type': 'link'})
                await self.enqueue(owner, event_id, 'SALES-OS 연결이 완료되었습니다. 업무를 요청하시거나 대화목록, 새대화, 대화 <ID>를 보내 주세요.')
                accepted += 1; continue
            if not owner:
                ignored += 1; continue
            member = await self.repo.member(owner)
            link = await self.repo.get('line_links', owner, owner)
            if not member or not member.get('active') or not link or not link['data'].get('active') or link['data']['user_id'] != line_user:
                ignored += 1; continue
            if event.get('type') == 'unfollow':
                await self.disconnect(owner)
                await self.repo.insert('line_events', key, owner, {'processed_at': now(), 'type': 'unfollow'})
                accepted += 1; continue
            connection = await self.repo.get('connections', f'{owner}:line', owner)
            if connection and not connection['data'].get('enabled', True):
                ignored += 1; continue
            if not text:
                ignored += 1; continue
            try:
                await self.repo.insert('line_events', key, owner, {'processed_at': now(), 'type': 'message'})
            except HTTPException as exc:
                if exc.status_code == 409: duplicates += 1; continue
                raise
            await self.repo.insert('jobs', 'line_' + key, owner, {
                'kind': 'line_chat', 'title': text[:80], 'text': text[:20000], 'event_id': event_id,
                'status': 'pending', 'created_at': now(), 'updated_at': now(),
            })
            accepted += 1
        return {'ok': True, 'accepted': accepted, 'duplicates': duplicates, 'ignored': ignored}

    async def run_chat(self, row):
        owner, data = row['owner_id'], row['data']
        member = await self.repo.member(owner)
        if not member or not member.get('active'):
            raise HTTPException(403, '비활성 직원입니다.')
        await self.providers.connection(owner, 'line')
        text = data['text'].strip()
        state = await self.repo.get('line_context', owner, owner)
        thread_id = state['data'].get('thread_id') if state else None
        if text == '대화목록':
            threads = await self.repo.list('threads', owner, limit=20)
            reply = '\n'.join(f"{r['data'].get('title') or '제목 없는 대화'}\n대화 {r['id']}" for r in threads) or '아직 대화가 없습니다.'
            await self.enqueue(owner, data['event_id'], reply); return
        if text == '새대화':
            await self.repo.save('line_context', owner, owner, {'thread_id': None})
            await self.enqueue(owner, data['event_id'], '새 대화로 전환했습니다. 요청을 보내 주세요.'); return
        if text.startswith('대화 '):
            selected = text[3:].strip()
            thread = await self.repo.get('threads', selected, owner)
            if not thread: raise HTTPException(404, '본인의 대화 ID를 확인해 주세요.')
            await self.repo.save('line_context', owner, owner, {'thread_id': selected})
            await self.enqueue(owner, data['event_id'], f"{thread['data'].get('title') or '선택한 대화'}에서 이어서 대화합니다."); return
        if thread_id and not await self.repo.get('threads', thread_id, owner): thread_id = None
        user_input = {'content': [{'type': 'input_text', 'text': text}], 'attachments': [], 'inference_options': {}}
        payload = {'type': 'threads.add_user_message' if thread_id else 'threads.create', 'params': {'input': user_input}}
        if thread_id: payload['params']['thread_id'] = thread_id
        result = await self.chat.process(json.dumps(payload).encode(), {'member': member, 'channel': 'line'})
        reply_parts = []; failure = False; buffer = ''
        async for chunk in result:
            buffer += chunk.decode()
            while '\n\n' in buffer:
                packet, buffer = buffer.split('\n\n', 1)
                for line in packet.splitlines():
                    if not line.startswith('data:'): continue
                    try: event = json.loads(line[5:])
                    except ValueError: continue
                    if event.get('type') == 'thread.created': thread_id = event['thread']['id']
                    if event.get('type') == 'thread.item.done' and event.get('item', {}).get('type') == 'assistant_message':
                        reply_parts.extend(c.get('text', '') for c in event['item'].get('content', []))
                    if event.get('type') == 'error': failure = True
        if thread_id:
            await self.repo.save('line_context', owner, owner, {'thread_id': thread_id})
            current = await self.repo.get('jobs', row['id'], owner)
            await self.repo.cas(current, {**current['data'], 'thread_id': thread_id})
        await self.enqueue(owner, data['event_id'], '\n'.join(reply_parts) or '응답을 완성하지 못했습니다. 웹 대화에서 확인 후 다시 요청해 주세요.')
        if failure: raise HTTPException(502, 'AI 응답을 완료하지 못했습니다.')

    async def claim_outbound(self):
        for row in reversed(await self.repo.list('line_outbound', limit=200)):
            data = row['data']
            if data['status'] not in ('pending', 'processing'): continue
            if data['status'] == 'processing' and not is_expired(data.get('lease_until')): continue
            link = await self.repo.get('line_links', row['owner_id'], row['owner_id'])
            member = await self.repo.member(row['owner_id'])
            if not member or not member.get('active') or not link or not link['data'].get('active') or link['data']['user_id'] != data['to']:
                await self.repo.cas(row, {**data, 'status': 'cancelled'}); continue
            if data.get('attempts', 0) >= 3:
                await self.repo.cas(row, {**data, 'status': 'failed', 'error': 'LINE 전달 재시도 한도를 초과했습니다.'}); continue
            lease = secrets.token_urlsafe(24)
            claimed = await self.repo.cas(row, {**data, 'status': 'processing', 'attempts': data.get('attempts', 0) + 1, 'lease_until': expires(2), 'lease_token': lease})
            if claimed:
                return {'message': {'id': row['id'], 'to': data['to'], 'messages': data['messages'], 'retry_key': data['retry_key'], 'lease_token': lease}}
        return {'message': None}

    async def outbound_result(self, id, payload):
        row = await self.repo.get('line_outbound', id)
        if not row: raise HTTPException(404, '전달 요청이 없습니다.')
        data = row['data']
        if data['status'] == 'succeeded': return {'ok': True, 'duplicate': True}
        if data['status'] != 'processing' or not hmac.compare_digest(data.get('lease_token', ''), str(payload.get('lease_token', ''))):
            raise HTTPException(409, '전달 작업의 실행 권한이 만료되었습니다.')
        status = 'succeeded' if payload.get('accepted') is True else 'pending' if data.get('attempts', 0) < 3 else 'failed'
        updated = await self.repo.cas(row, {**data, 'status': status, 'updated_at': now(), 'error': None if status == 'succeeded' else 'LINE API가 전달을 수락하지 않았습니다.'})
        if not updated: raise HTTPException(409, '전달 상태가 변경되었습니다.')
        return {'ok': True, 'status': status}

    async def reconcile(self):
        # Called by n8n on a schedule; no unmanaged always-running worker is required.
        if self.lock.locked(): return {'processed': 0, 'busy': True}
        processed = 0
        async with self.lock:
            for row in reversed(await self.repo.list('jobs', limit=200)):
                data = row['data']
                if data.get('kind') not in ('line_chat', 'notion_contact') or data['status'] != 'pending': continue
                claimed = await self.repo.cas(row, {**data, 'status': 'processing', 'updated_at': now()})
                if not claimed: continue
                try:
                    if data['kind'] == 'line_chat':
                        await self.run_chat(claimed)
                    else:
                        contact = await self.repo.get('contacts', data['contact_id'], row['owner_id'])
                        if not contact: raise HTTPException(404, '연락처가 없습니다.')
                        values = contact['data']
                        body = '\n'.join(f'{k}: {values.get(k, "")}' for k in ('company', 'email', 'phone', 'memo'))
                        page = await self.providers.notion(row['owner_id'], 'POST', 'pages', json={
                            'parent': {'page_id': data['parent_page_id']},
                            'properties': {'title': {'type': 'title', 'title': [{'type': 'text', 'text': {'content': values['name'][:200]}}]}},
                            'children': [{'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': [{'type': 'text', 'text': {'content': body[:2000]}}]}}],
                        })
                        await self.repo.cas(contact, {**values, 'notion_page_id': page['id'], 'notion_url': page.get('url')})
                    current = await self.repo.get('jobs', row['id'], row['owner_id'])
                    await self.repo.cas(current, {**current['data'], 'status': 'succeeded', 'updated_at': now()})
                except Exception:
                    current = await self.repo.get('jobs', row['id'], row['owner_id'])
                    await self.repo.cas(current, {**current['data'], 'status': 'failed', 'updated_at': now(), 'error': '작업을 완료하지 못했습니다. 연결과 권한을 확인해 주세요.'})
                processed += 1
                if processed >= 3: break
        return {'processed': processed}
