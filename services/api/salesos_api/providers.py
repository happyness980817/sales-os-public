import asyncio
import base64
import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, quote
from time import monotonic
import httpx
from fastapi import HTTPException
from .repository import Repository, now
from .security import Security, digest, expires, is_expired
from .config import Settings

NOTION_VERSION = '2025-09-03'

GOOGLE_SCOPES = {
    'google_drive': ['https://www.googleapis.com/auth/drive.readonly'],
    'gmail': ['https://www.googleapis.com/auth/gmail.readonly'],
    'google_sheets': ['https://www.googleapis.com/auth/spreadsheets'],
    'google_chat': ['https://www.googleapis.com/auth/chat.spaces.readonly', 'https://www.googleapis.com/auth/chat.messages.readonly'],
    'google_calendar': ['https://www.googleapis.com/auth/calendar.events'],
}
CATALOG = [
    ('google_drive','Google Drive','문서를 찾아 읽고 업무에 활용합니다.','services'),
    ('gmail','Gmail','내 메일을 검색하고 내용을 정리합니다.','services'),
    ('google_sheets','Google Sheets','미팅 일정과 업무 데이터를 관리합니다.','services'),
    ('google_chat','Google Chat','허용한 채팅방의 대화를 읽습니다.','services'),
    ('google_calendar','Google Calendar','일정을 조회하고 등록합니다.','services'),
    ('notion','Notion','페이지를 읽고 명함첩을 연결합니다.','services'),
    ('line','LINE','모바일에서 대화하고 알림을 받습니다.','channels'),
    ('local_files','내 PC','선택한 폴더의 파일을 읽습니다.','devices'),
]


class Providers:
    def __init__(self, settings: Settings, repo: Repository, security: Security):
        self.settings,self.repo,self.security = settings,repo,security
        self.refresh_locks = {}

    @staticmethod
    def google_connection_id(owner, subject):
        # Neither an email address nor a user-supplied ID is an account identity.
        return 'google_' + digest(json.dumps([owner, 'google', subject], separators=(',', ':')))

    async def migrate_google(self, owner):
        """Copy the single-account format once, without replacing newer records.

        The existing (namespace, id) constraint and CAS make this resumable after
        interruption. Keep a marker instead of deleting the legacy row, so a
        disconnect cannot make a later read resurrect its old credential.
        """
        legacy = await self.repo.get('provider_secrets', f'{owner}:google', owner)
        if not legacy or legacy['data'].get('migrated_to'):
            return
        data = legacy['data']
        subject = data.get('subject')
        if not isinstance(subject, str) or not subject or not data.get('encrypted'):
            return  # An unidentified legacy grant requires a fresh connection.
        connection_id = self.google_connection_id(owner, subject)
        services = {}
        for service, scopes in GOOGLE_SCOPES.items():
            old = await self.repo.get('connections', f'{owner}:{service}', owner)
            old_data = old['data'] if old else {}
            connected = (old_data.get('subject', subject) == subject and
                         bool(old_data.get('connected')) and set(scopes) <= set(data.get('scopes', [])))
            services[service] = {'connected': connected, 'enabled': connected and old_data.get('enabled', True)}
        copied = {**data, 'provider': 'google', 'connection_id': connection_id, 'services': services,
                  'legacy': True, 'updated_at': now()}
        try:
            await self.repo.insert('provider_secrets', connection_id, owner, copied)
        except HTTPException as exc:
            if exc.status_code != 409:
                raise
        # This allowlist belongs only to the legacy account, never every Google account.
        old_spaces = await self.repo.get('settings', f'{owner}:chat_spaces', owner)
        if old_spaces:
            try:
                await self.repo.insert('settings', f'{owner}:chat_spaces:{connection_id}', owner,
                                       {**old_spaces['data'], 'connection_id': connection_id})
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise
        if not await self.repo.cas(legacy, {'migrated_to': connection_id, 'subject': subject, 'updated_at': now()}):
            # Another request may have migrated it; a different concurrent change
            # must not be silently accepted as the source of this account.
            current = await self.repo.get('provider_secrets', f'{owner}:google', owner)
            if not current or current['data'].get('migrated_to') != connection_id:
                raise HTTPException(409, 'Google 연결이 변경되었습니다. 다시 시도해 주세요.')

    def account_view(self, row, service):
        data = row['data']
        state = data.get('services', {}).get(service, {})
        connected = (not data.get('revoked') and bool(data.get('encrypted')) and bool(state.get('connected'))
                     and set(GOOGLE_SCOPES[service]) <= set(data.get('scopes', [])))
        return {'connection_id': row['id'], 'provider': 'google', 'service': service,
                'account': data.get('account', 'Google'), 'subject': data.get('subject'),
                'connected': connected, 'enabled': connected and bool(state.get('enabled', True)),
                'status': 'connected' if connected else 'not_connected', 'updated_at': data.get('updated_at', row.get('updated_at'))}

    async def accounts(self, owner, service):
        if service not in GOOGLE_SCOPES:
            if service != 'notion':
                raise HTTPException(404, '계정을 연결할 수 없는 서비스입니다.')
            row = await self.repo.get('connections', f'{owner}:notion', owner)
            if not row or not row['data'].get('connected'):
                return []
            data = row['data']
            return [{'connection_id': f'{owner}:notion', 'provider': 'notion', 'service': service,
                     'account': data.get('account'), 'subject': data.get('subject'), 'connected': True,
                     'enabled': data.get('enabled', True), 'status': 'connected', 'updated_at': data.get('updated_at')}]
        await self.migrate_google(owner)
        rows = await self.repo.list('provider_secrets', owner)
        return [self.account_view(row, service) for row in rows
                if row['data'].get('provider') == 'google' and not row['data'].get('revoked')]

    async def google_account(self, owner, connection_id):
        await self.migrate_google(owner)
        if not isinstance(connection_id, str) or not connection_id.startswith('google_'):
            raise HTTPException(404, '연결 계정을 찾을 수 없습니다.')
        row = await self.repo.get('provider_secrets', connection_id, owner)
        if not row or row['data'].get('provider') != 'google' or row['data'].get('revoked'):
            raise HTTPException(404, '연결 계정을 찾을 수 없습니다.')
        return row

    async def select_google(self, owner, service, connection_id=None, *, allow_disabled=False):
        if connection_id is None:
            choices = [item for item in await self.accounts(owner, service)
                       if item['connected'] and (allow_disabled or item['enabled'])]
            if not choices:
                raise HTTPException(409, '사용할 Google 계정을 연결하고 켜 주세요.')
            if len(choices) > 1:
                raise HTTPException(409, '여러 Google 계정이 연결되어 있습니다. connection_id로 사용할 계정을 선택해 주세요.')
            connection_id = choices[0]['connection_id']
        row = await self.google_account(owner, connection_id)
        account = self.account_view(row, service)
        if not account['connected']:
            raise HTTPException(409, '이 계정에 해당 서비스 접근 권한을 연결해 주세요.')
        if not allow_disabled and not account['enabled']:
            raise HTTPException(409, '이 계정의 서비스 사용이 꺼져 있습니다.')
        return row

    async def toggle_account(self, owner, service, connection_id, enabled):
        if type(enabled) is not bool:
            raise HTTPException(400, '사용 여부를 확인해 주세요.')
        if service not in GOOGLE_SCOPES:
            if service != 'notion' or connection_id != f'{owner}:notion':
                raise HTTPException(404, '연결 계정을 찾을 수 없습니다.')
            row = await self.repo.get('connections', connection_id, owner)
            if not row or not row['data'].get('connected'):
                raise HTTPException(409, '먼저 서비스를 연결해 주세요.')
            if not await self.repo.cas(row, {**row['data'], 'enabled': enabled, 'updated_at': now()}):
                raise HTTPException(409, '연결 상태가 변경되었습니다. 다시 시도해 주세요.')
            return (await self.accounts(owner, service))[0]
        row = await self.select_google(owner, service, connection_id, allow_disabled=True)
        services = {**row['data']['services'], service: {**row['data']['services'][service], 'enabled': enabled}}
        updated = await self.repo.cas(row, {**row['data'], 'services': services, 'updated_at': now()})
        if not updated:
            raise HTTPException(409, '연결 상태가 변경되었습니다. 다시 시도해 주세요.')
        return self.account_view(updated, service)

    async def connections(self, owner):
        saved_rows, devices, line, _ = await asyncio.gather(
            self.repo.list('connections', owner), self.repo.list('devices', owner),
            self.repo.get('line_links', owner, owner), self.migrate_google(owner))
        saved = {row['id'].split(':', 1)[-1]: row['data'] for row in saved_rows}
        google_accounts = [row for row in await self.repo.list('provider_secrets', owner)
                           if row['data'].get('provider') == 'google' and not row['data'].get('revoked')]
        output=[]
        for id,name,description,category in CATALOG:
            item = saved.get(id,{})
            accounts = [self.account_view(row, id) for row in google_accounts] if id in GOOGLE_SCOPES else []
            if id in GOOGLE_SCOPES:
                connected_accounts = [account for account in accounts if account['connected']]
                item = {'connected': bool(connected_accounts), 'enabled': any(account['enabled'] for account in connected_accounts),
                        'account': connected_accounts[0]['account'] if len(connected_accounts) == 1 else None,
                        'updated_at': max((account['updated_at'] or '' for account in accounts), default=None)}
            connected = bool(item.get('connected'))
            configured = self.settings.google_ready if id in GOOGLE_SCOPES else self.settings.notion_ready if id=='notion' else self.settings.line_ready if id=='line' else True
            if id=='local_files':
                connected = any(not d['data'].get('revoked') for d in devices)
            if id=='line':
                connected = bool(line and line['data'].get('active'))
            output.append({'id':id,'provider':id,'name':name,'description':description,'category':category,
                'configured':configured,'connected':connected,'enabled':connected and item.get('enabled',True),
                'account': item.get('account'), 'status': 'connected' if connected else 'not_connected',
                'updated_at':item.get('updated_at'), **({'accounts': accounts, 'account_count': len(connected_accounts)} if id in GOOGLE_SCOPES else {})})
        return output

    async def connection(self, owner, provider, connection_id=None):
        if provider in GOOGLE_SCOPES:
            row = await self.select_google(owner, provider, connection_id)
            return {**row, 'data': {**self.account_view(row, provider), 'version': row['data'].get('version', 0)}}
        if connection_id is not None and connection_id != f'{owner}:{provider}':
            raise HTTPException(404, '연결 계정을 찾을 수 없습니다.')
        row=await self.repo.get('connections',f'{owner}:{provider}',owner)
        if not row or not row['data'].get('connected'):
            raise HTTPException(409,'먼저 서비스를 연결해 주세요.')
        if not row['data'].get('enabled',True):
            raise HTTPException(409,'이 서비스는 대화에서 사용하지 않도록 설정되어 있습니다.')
        return row

    async def start(self,owner,provider,connection_id=None):
        if provider not in GOOGLE_SCOPES and provider!='notion':
            raise HTTPException(400,'이 서비스는 별도의 연결 화면에서 연결해 주세요.')
        is_google = provider in GOOGLE_SCOPES
        if not (self.settings.google_ready if is_google else self.settings.notion_ready):
            raise HTTPException(503,'서비스의 OAuth 설정이 아직 준비되지 않았습니다. 관리자에게 문의해 주세요.')
        state=secrets.token_urlsafe(32)
        verifier=secrets.token_urlsafe(48)
        scopes=set(GOOGLE_SCOPES.get(provider,[]))
        existing = None
        if is_google:
            await self.migrate_google(owner)
            if connection_id is not None:
                existing = await self.google_account(owner, connection_id)
                scopes.update(existing['data'].get('scopes', []))
        elif connection_id is not None and connection_id != f'{owner}:notion':
            raise HTTPException(404, '연결 계정을 찾을 수 없습니다.')
        payload={'provider':provider,'connection_id':connection_id,'expires_at':expires(),'consumed':False,'verifier':self.security.encrypt(verifier),'scopes':sorted(scopes)}
        if existing:
            payload['connection_version'] = existing['data'].get('version', 0)
        if is_google:
            payload['account_versions'] = {row['id']: row['data'].get('version', 0)
                                           for row in await self.repo.list('provider_secrets', owner)
                                           if row['data'].get('provider') == 'google'}
        await self.repo.insert('oauth_states',digest(state),owner,payload)
        callback=self.settings.public_url.rstrip('/')+'/api/connections/'+('google' if is_google else 'notion')+'/callback'
        if is_google:
            params={'client_id':self.settings.google_client_id,'redirect_uri':callback,'response_type':'code',
                'scope':' '.join(sorted(scopes|{'openid','email'})),'access_type':'offline','prompt':'select_account consent',
                'state':state,'include_granted_scopes':'true','code_challenge_method':'S256',
                'code_challenge':base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')}
            if existing:
                params['login_hint'] = existing['data']['subject']
            return 'https://accounts.google.com/o/oauth2/v2/auth?'+urlencode(params)
        return 'https://api.notion.com/v1/oauth/authorize?'+urlencode({'client_id':self.settings.notion_client_id,'response_type':'code','owner':'user','redirect_uri':callback,'state':state})

    async def callback(self,kind,state,code):
        row=await self.repo.get('oauth_states',digest(state))
        if not row or row['data'].get('consumed') or is_expired(row['data']['expires_at']):
            raise HTTPException(400,'연결 요청이 만료되었거나 이미 사용되었습니다.')
        data=row['data']; owner=row['owner_id']
        if (kind=='google') != (data['provider'] in GOOGLE_SCOPES):
            raise HTTPException(400,'올바르지 않은 연결 요청입니다.')
        if not await self.repo.cas(row,{**data,'consumed':True}):
            raise HTTPException(409,'이미 처리 중인 연결 요청입니다.')
        member=await self.repo.member(owner)
        if not member or not member.get('active'):
            raise HTTPException(403,'비활성 계정입니다.')
        callback=self.settings.public_url.rstrip('/')+f'/api/connections/{kind}/callback'
        async with httpx.AsyncClient(timeout=25) as client:
            if kind=='google':
                res=await client.post('https://oauth2.googleapis.com/token',data={
                    'client_id':self.settings.google_client_id,'client_secret':self.settings.google_client_secret,
                    'code':code,'grant_type':'authorization_code','redirect_uri':callback,
                    'code_verifier':self.security.decrypt(data['verifier'])})
            else:
                res=await client.post('https://api.notion.com/v1/oauth/token',auth=(self.settings.notion_client_id,self.settings.notion_client_secret),
                    headers={'Notion-Version': NOTION_VERSION},
                    json={'grant_type':'authorization_code','code':code,'redirect_uri':callback})
            if res.status_code>=400:
                raise HTTPException(400,'서비스가 연결 요청을 거절했습니다. 다시 연결해 주세요.')
            tokens=res.json()
            if kind=='google':
                profile=await client.get('https://openidconnect.googleapis.com/v1/userinfo',headers={'Authorization':'Bearer '+tokens['access_token']})
                if profile.status_code!=200:
                    raise HTTPException(400,'연결한 Google 계정을 확인하지 못했습니다.')
                profile=profile.json(); account=profile.get('email','Google'); subject=profile['sub']
                await self.migrate_google(owner)
                connection_id = self.google_connection_id(owner, subject)
                if data.get('connection_id') and data['connection_id'] != connection_id:
                    raise HTTPException(409, '선택한 계정과 승인한 Google 계정이 다릅니다. 계정 추가에서 다시 연결해 주세요.')
                old=await self.repo.get('provider_secrets',connection_id,owner)
                if old and 'account_versions' in data and (old['data'].get('version', 0)
                        != data['account_versions'].get(connection_id, 0)):
                    raise HTTPException(409, '승인 중 Google 연결이 변경되었습니다. 다시 연결해 주세요.')
                if data.get('connection_id') and (not old or old['data'].get('revoked')
                        or old['data'].get('version', 0) != data.get('connection_version')):
                    raise HTTPException(409, '승인 중 Google 연결이 변경되었습니다. 다시 연결해 주세요.')
                if old and not old['data'].get('revoked') and old['data'].get('encrypted'):
                    old_tokens=json.loads(self.security.decrypt(old['data']['encrypted']))
                    tokens.setdefault('refresh_token',old_tokens.get('refresh_token'))
                scopes=tokens.get('scope',' '.join(data['scopes'])).split()
                if not tokens.get('refresh_token'):
                    raise HTTPException(400,'오프라인 접근 권한이 없습니다. Google 권한을 확인하고 다시 연결해 주세요.')
                tokens['expires_at']=(datetime.now(timezone.utc)+timedelta(seconds=tokens.get('expires_in',3600))).isoformat()
            else:
                account=tokens.get('workspace_name') or 'Notion';subject=tokens['workspace_id'];scopes=[]
        if kind == 'google':
            # The grant and all service flags share one CAS record. A concurrent
            # disconnect/toggle/refresh wins rather than being overwritten.
            previous = old['data'] if old else {}
            services = {}
            for provider, required in GOOGLE_SCOPES.items():
                before = previous.get('services', {}).get(provider, {})
                granted = set(required) <= set(scopes)
                connected = granted and (provider == data['provider'] or bool(before.get('connected')))
                enabled = connected and (before.get('enabled', True) if before.get('connected') else provider == data['provider'])
                services[provider] = {'connected': connected, 'enabled': enabled}
            updated_data = {'provider': 'google', 'connection_id': connection_id, 'subject': subject, 'account': account,
                            'encrypted': self.security.encrypt(json.dumps(tokens)), 'scopes': scopes,
                            'services': services, 'version': previous.get('version', 0) + 1, 'updated_at': now()}
            if old:
                if not await self.repo.cas(old, updated_data):
                    raise HTTPException(409, 'Google 연결 상태가 변경되었습니다. 다시 연결해 주세요.')
            else:
                await self.repo.insert('provider_secrets', connection_id, owner, updated_data)
            return owner
        old_secret=await self.repo.get('provider_secrets',f'{owner}:{kind}',owner)
        version=(old_secret['data'].get('version',0) if old_secret else 0)+1
        await self.repo.save('provider_secrets',f'{owner}:{kind}',owner,{'encrypted':self.security.encrypt(json.dumps(tokens)),
            'subject':subject,'scopes':scopes,'version':version,'account':account})
        available=GOOGLE_SCOPES if kind=='google' else {'notion':[]}
        for provider,required in available.items():
            previous=await self.repo.get('connections',f'{owner}:{provider}',owner)
            granted=all(scope in scopes for scope in required)
            old=previous['data'] if previous else {}
            # A different Google account cannot silently inherit old per-service grants.
            await self.repo.save('connections',f'{owner}:{provider}',owner,{
                'connected':granted,'enabled':granted and (provider==data['provider'] or old.get('enabled',True)),
                'account':account,'subject':subject,'version':version,'updated_at':now()})
        return owner

    async def google_token(self,owner,provider,connection_id=None):
        selected = await self.select_google(owner, provider, connection_id)
        key=selected['id']
        lock=self.refresh_locks.setdefault(('google',key),asyncio.Lock())
        async with lock:
            row=await self.select_google(owner, provider, key)
            tokens=json.loads(self.security.decrypt(row['data']['encrypted']))
            if datetime.fromisoformat(tokens['expires_at'])>datetime.now(timezone.utc)+timedelta(seconds=60):
                return tokens['access_token']
            async with httpx.AsyncClient(timeout=20) as client:
                res=await client.post('https://oauth2.googleapis.com/token',data={'client_id':self.settings.google_client_id,
                    'client_secret':self.settings.google_client_secret,'grant_type':'refresh_token','refresh_token':tokens.get('refresh_token')})
            if res.status_code!=200:
                raise HTTPException(409,'Google 권한이 만료되었거나 철회되었습니다. 다시 연결해 주세요.')
            refreshed=res.json()
            if not isinstance(refreshed.get('access_token'), str) or not refreshed['access_token']:
                raise HTTPException(502, 'Google 연결 갱신 응답을 확인하지 못했습니다.')
            tokens.update(refreshed)
            tokens['expires_at']=(datetime.now(timezone.utc)+timedelta(seconds=refreshed.get('expires_in',3600))).isoformat()
            scopes = refreshed['scope'].split() if isinstance(refreshed.get('scope'), str) else row['data'].get('scopes', [])
            updated=await self.repo.cas(row,{**row['data'],'scopes':scopes,'encrypted':self.security.encrypt(json.dumps(tokens))})
            if not updated:
                raise HTTPException(409,'Google 연결 상태가 바뀌었습니다. 다시 시도해 주세요.')
            await self.select_google(owner, provider, key)
            return tokens['access_token']

    async def google(self,owner,provider,method,url,*,connection_id=None,**kwargs):
        before = await self.connection(owner, provider, connection_id)
        connection_id = before['data']['connection_id']
        token=await self.google_token(owner,provider,connection_id)
        after = await self.connection(owner, provider, connection_id)
        if before['data']['version'] != after['data']['version']:
            raise HTTPException(409, 'Google 연결이 변경되어 요청을 중단했습니다.')
        if not url.startswith(('https://www.googleapis.com/','https://gmail.googleapis.com/','https://chat.googleapis.com/','https://sheets.googleapis.com/')):
            raise HTTPException(400,'허용되지 않은 Google API입니다.')
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                res=await client.request(method,url,headers={'Authorization':'Bearer '+token},**kwargs)
        except httpx.HTTPError:
            raise HTTPException(503,'Google 응답을 확인하지 못했습니다.') from None
        if res.status_code in (401,403):
            raise HTTPException(403,'연결 계정에 자료를 읽거나 변경할 권한이 없습니다.')
        if res.status_code>=400:
            raise HTTPException(502,'Google 자료를 처리하지 못했습니다. 대상과 연결 상태를 확인해 주세요.')
        return res

    @staticmethod
    def notion_identity(row):
        return row['data'].get('subject'), row['data'].get('version', 0)

    async def notion_credentials(self, owner):
        connection = await self.connection(owner, 'notion')
        row = await self.repo.get('provider_secrets', f'{owner}:notion', owner)
        if not row:
            raise HTTPException(409, 'Notion을 다시 연결해 주세요.')
        if (connection['data'].get('version') is not None
                and connection['data']['version'] != row['data'].get('version')):
            raise HTTPException(409, 'Notion 연결 상태가 변경되었습니다. 다시 시도해 주세요.')
        tokens = json.loads(self.security.decrypt(row['data']['encrypted']))
        if not tokens.get('access_token'):
            raise HTTPException(409, 'Notion을 다시 연결해 주세요.')
        return row, tokens

    async def refresh_notion(self, owner, failed_row, failed_token):
        # Local locking handles concurrent requests in one process. The record's
        # CAS lease also protects rotating, single-use refresh tokens across instances.
        lock = self.refresh_locks.setdefault(('notion', owner), asyncio.Lock())
        async with lock:
            deadline = monotonic() + 25
            while True:
                row, tokens = await self.notion_credentials(owner)
                if self.notion_identity(row) != self.notion_identity(failed_row):
                    raise HTTPException(409, 'Notion 계정이 변경되었습니다. 요청을 다시 확인해 주세요.')
                if tokens['access_token'] != failed_token:
                    return row, tokens  # Another request already rotated the token pair.
                if not tokens.get('refresh_token'):
                    raise HTTPException(409, 'Notion 권한이 만료되었습니다. 다시 연결해 주세요.')
                if not self.settings.notion_client_id or not self.settings.notion_client_secret:
                    raise HTTPException(503, 'Notion OAuth 설정을 확인해 주세요.')
                lease = row['data'].get('refresh_lease')
                if not lease or is_expired(lease.get('expires_at')):
                    lease_id = secrets.token_urlsafe(24)
                    claimed = await self.repo.cas(row, {**row['data'], 'refresh_lease': {'id': lease_id, 'expires_at': expires(1)}})
                    if claimed:
                        break
                if monotonic() >= deadline:
                    raise HTTPException(409, 'Notion 연결을 갱신하고 있습니다. 잠시 후 다시 시도해 주세요.')
                await asyncio.sleep(0.1)
            try:
                async with httpx.AsyncClient(timeout=20) as client:
                    response = await client.post('https://api.notion.com/v1/oauth/token',
                        auth=(self.settings.notion_client_id, self.settings.notion_client_secret),
                        headers={'Notion-Version': NOTION_VERSION},
                        json={'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token']})
                if response.status_code in (400, 401, 403):
                    raise HTTPException(409, 'Notion 권한이 만료되었거나 철회되었습니다. 다시 연결해 주세요.')
                if response.status_code >= 400:
                    raise HTTPException(502, 'Notion 연결 갱신에 실패했습니다. 잠시 후 다시 시도해 주세요.')
                refreshed = response.json()
                if not refreshed.get('access_token') or not refreshed.get('refresh_token'):
                    raise HTTPException(502, 'Notion 연결 갱신 응답을 확인하지 못했습니다. 다시 연결해 주세요.')
                updated_data = {**claimed['data'], 'encrypted': self.security.encrypt(json.dumps({**tokens, **refreshed}))}
                updated_data.pop('refresh_lease', None)
                updated = await self.repo.cas(claimed, updated_data)
                if not updated:
                    # Never resurrect a disconnected credential or replace a newly linked account.
                    raise HTTPException(409, 'Notion 연결이 변경되어 요청을 중단했습니다.')
                current, current_tokens = await self.notion_credentials(owner)
                if self.notion_identity(current) != self.notion_identity(failed_row):
                    raise HTTPException(409, 'Notion 계정이 변경되었습니다. 요청을 다시 확인해 주세요.')
                return current, current_tokens
            finally:
                current = await self.repo.get('provider_secrets', f'{owner}:notion', owner)
                if current and (current['data'].get('refresh_lease') or {}).get('id') == lease_id:
                    unlocked = dict(current['data'])
                    unlocked.pop('refresh_lease', None)
                    await self.repo.cas(current, unlocked)

    async def notion(self,owner,method,path,**kwargs):
        row, tokens = await self.notion_credentials(owner)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                async def send(token):
                    return await client.request(method, 'https://api.notion.com/v1/' + path, headers={
                        'Authorization': 'Bearer ' + token, 'Notion-Version': NOTION_VERSION,
                        'Content-Type': 'application/json'}, **kwargs)
                res = await send(tokens['access_token'])
                if res.status_code == 401:
                    # A definite 401 is safe to retry. No retries for timeouts, 403,
                    # or uncertain write failures that might duplicate a Notion page.
                    row, tokens = await self.refresh_notion(owner, row, tokens['access_token'])
                    res = await send(tokens['access_token'])
        except httpx.HTTPError:
            raise HTTPException(503, 'Notion 응답을 확인하지 못했습니다. 연결 상태를 확인해 주세요.') from None
        if res.status_code == 401:
            raise HTTPException(409, 'Notion 인증이 만료되었습니다. 다시 연결해 주세요.')
        if res.status_code >= 400:
            raise HTTPException(502, 'Notion에서 자료를 처리하지 못했습니다. 연결한 페이지 권한을 확인해 주세요.')
        return res.json()

    async def disconnect(self,owner,provider,connection_id=None):
        if provider not in {c[0] for c in CATALOG}:
            raise HTTPException(404,'서비스가 없습니다.')
        if provider in GOOGLE_SCOPES:
            row = await self.select_google(owner, provider, connection_id, allow_disabled=True)
            services = {**row['data']['services'], provider: {'connected': False, 'enabled': False}}
            data = {**row['data'], 'services': services, 'version': row['data'].get('version', 0) + 1, 'updated_at': now()}
            if not any(state.get('connected') for state in services.values()):
                data.pop('encrypted', None)
                data['revoked'] = True
            if not await self.repo.cas(row, data):
                raise HTTPException(409, 'Google 연결 상태가 변경되었습니다. 다시 시도해 주세요.')
            return
        if connection_id is not None and connection_id != f'{owner}:{provider}':
            raise HTTPException(404, '연결 계정을 찾을 수 없습니다.')
        row=await self.repo.get('connections',f'{owner}:{provider}',owner)
        await self.repo.save('connections',f'{owner}:{provider}',owner,{
            **(row['data'] if row else {}),'connected':False,'enabled':False,'updated_at':now(),
            'version':(row['data'].get('version',0) if row else 0)+1})
        if provider=='notion':
            await self.repo.delete('provider_secrets',f'{owner}:notion',owner)
