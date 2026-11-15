import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath, PureWindowsPath
from uuid import UUID
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Request
import httpx
from .config import Settings
from .repository import Repository, now

DEV_USER_ID = '00000000-0000-4000-8000-000000000001'


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def expires(minutes: int = 10):
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def is_expired(value: str):
    try:
        return datetime.fromisoformat(value) <= datetime.now(timezone.utc)
    except (ValueError, TypeError):
        return True


def relative_path(value: str):
    if not value or '\x00' in value or ':' in value or value.startswith(('\\', '/')):
        raise HTTPException(400, '허용 폴더 안의 파일만 선택할 수 있습니다.')
    normalized = value.replace('\\', '/')
    if PureWindowsPath(value).is_absolute() or '..' in PurePosixPath(normalized).parts:
        raise HTTPException(400, '상위 폴더 경로는 사용할 수 없습니다.')
    return normalized


class Security:
    def __init__(self, settings: Settings, repo: Repository):
        self.settings, self.repo = settings, repo

    def encrypt(self, data: str):
        if not self.settings.token_encryption_key:
            raise HTTPException(503, '서버의 연결 정보 암호화 설정이 필요합니다.')
        key = base64.urlsafe_b64encode(hashlib.sha256(self.settings.token_encryption_key.encode()).digest())
        return Fernet(key).encrypt(data.encode()).decode()

    def decrypt(self, data: str):
        key = base64.urlsafe_b64encode(hashlib.sha256(self.settings.token_encryption_key.encode()).digest())
        try:
            return Fernet(key).decrypt(data.encode()).decode()
        except (InvalidToken, ValueError):
            raise HTTPException(503, '연결 정보를 복호화할 수 없습니다. 관리자에게 문의해 주세요.') from None

    @staticmethod
    def bearer(request: Request):
        authorization = request.headers.get('authorization', '')
        if not authorization.startswith('Bearer '):
            raise HTTPException(401, '로그인이 필요합니다.')
        return authorization[7:]

    def local_dev(self, request: Request):
        origin = request.headers.get('origin', '')
        host = request.client.host if request.client else ''
        allowed = {self.settings.public_url.rstrip('/'), 'http://localhost:5173', 'http://127.0.0.1:5173'}
        return self.settings.dev_mode and host in {'127.0.0.1','::1','testclient','localhost'} and (not origin or origin in allowed)

    @staticmethod
    def check_screen_member(request: Request, user_id: str):
        expected = request.headers.get('x-salesos-member')
        if expected and expected != user_id:
            raise HTTPException(409, '로그인 계정이 변경되었습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.')

    async def user(self, request: Request):
        token = self.bearer(request)
        if self.local_dev(request) and hmac.compare_digest(token, self.settings.dev_token):
            member = {'id': DEV_USER_ID, 'auth_user_id': DEV_USER_ID, 'email': 'dev@salesos.local', 'display_name': '로컬 개발', 'role': 'admin', 'active': True}
            # Dev identities cannot be inserted into the real auth.users FK.
            if self.repo.db is None:
                raise HTTPException(401, '실제 Supabase 저장소에서는 Supabase 계정으로 로그인해 주세요.')
            self.check_screen_member(request, DEV_USER_ID)
            await self.repo.create_member(member)
            return member
        if not self.settings.supabase_publishable_key:
            raise HTTPException(503, '로그인 서비스 설정이 필요합니다.')
        try:
            response = await self.repo.http_client().get(self.settings.supabase_url + '/auth/v1/user', timeout=15, headers={
                'apikey': self.settings.supabase_publishable_key, 'Authorization': f'Bearer {token}'})
        except httpx.HTTPError:
            raise HTTPException(503, '로그인 서버에 연결할 수 없습니다.') from None
        if response.status_code in {401, 403}:
            raise HTTPException(401, '로그인이 만료되었습니다. 다시 로그인해 주세요.')
        if response.status_code != 200:
            raise HTTPException(503, '로그인 서비스가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.')
        try:
            user = response.json()
            if not isinstance(user, dict) or not isinstance(user.get('id'), str):
                raise ValueError('Invalid identity')
            user_id = str(UUID(user['id']))
            email = user.get('email')
            if email is not None and not isinstance(email, str):
                raise ValueError('Invalid email')
            email = (email or '').lower()
            confirmed_at = user.get('email_confirmed_at')
            if confirmed_at is not None and not isinstance(confirmed_at, str):
                raise ValueError('Invalid confirmation')
            metadata = user.get('user_metadata') or {}
            if not isinstance(metadata, dict):
                raise ValueError('Invalid metadata')
        except (ValueError, TypeError):
            raise HTTPException(503, '로그인 서버 응답을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.') from None
        self.check_screen_member(request, user_id)
        name = metadata.get('full_name')
        display_name = name if isinstance(name, str) and name else email.split('@')[0]
        member = await self.repo.member(user_id)
        if not member and email in self.settings.admins and confirmed_at:
            member = await self.repo.create_member({'id': user_id, 'auth_user_id': user_id, 'email': email,
                'display_name': display_name, 'role': 'admin', 'active': True})
        if not member and confirmed_at:
            invitation = await self.repo.get('invitations', digest(email))
            if invitation and invitation['data'].get('active') and invitation['data'].get('email') == email:
                member = await self.repo.create_member({'id': user_id, 'auth_user_id': user_id, 'email': email,
                    'display_name': display_name, 'role': 'member', 'active': True})
        if not member or not member.get('active'):
            raise HTTPException(403, '초대된 활성 직원만 이용할 수 있습니다.')
        return member

    async def device(self, request: Request):
        token = self.bearer(request)
        record = await self.repo.get('device_tokens', digest(token))
        if not record or record['data'].get('revoked'):
            raise HTTPException(401, 'PC 연결이 해제되었습니다. 다시 연결해 주세요.')
        device = await self.repo.get('devices', record['data']['device_id'], record['owner_id'])
        member = await self.repo.member(record['owner_id'])
        if not device or device['data'].get('revoked') or not member or not member.get('active'):
            raise HTTPException(403, '사용할 수 없는 PC 연결입니다.')
        return device

    def internal(self, request: Request):
        key = self.settings.internal_api_key
        if not key or not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {key}'):
            raise HTTPException(401, '내부 호출 인증이 필요합니다.')
