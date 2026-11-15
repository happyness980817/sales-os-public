from pathlib import Path
from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CHAT_MODEL = 'gpt-6.1-sol'
CHAT_MODELS = (
    {'id': 'gpt-6-astra', 'label': 'GPT-6 Astra', 'description': '깊이 있는 분석과 복잡한 업무'},
    {'id': 'gpt-6.1-sol', 'label': 'GPT-6.1 Sol', 'description': '일상 업무와 자료 정리'},
    {'id': 'gpt-6.1-terra', 'label': 'GPT-6.1 Terra', 'description': '코드 작성과 개발 작업'},
    {'id': 'gpt-6-luna', 'label': 'GPT-6 Luna', 'description': '간단한 질문과 빠른 응답'},
)
CHAT_MODEL_IDS = frozenset(model['id'] for model in CHAT_MODELS)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(ROOT / '.env', ROOT / '.runtime/server.env'), extra='ignore', populate_by_name=True, validate_assignment=True)
    supabase_url: str = ''
    supabase_publishable_key: str = ''
    supabase_service_key: str = Field('', validation_alias=AliasChoices('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'))
    openai_api_key: str = ''
    openai_model: str = DEFAULT_CHAT_MODEL
    chatkit_domain_key: str = 'local-dev'
    dev_mode: bool = Field(False, validation_alias='SALESOS_DEV_MODE')
    dev_token: str = Field('salesos-local-dev', validation_alias='SALESOS_DEV_TOKEN')
    public_url: str = Field('http://localhost:5173', validation_alias='SALESOS_PUBLIC_URL')
    admin_emails: str = Field('', validation_alias=AliasChoices('SALESOS_ADMIN_EMAILS', 'BOOTSTRAP_ADMIN_EMAIL'))
    token_encryption_key: str = Field('', validation_alias=AliasChoices('TOKEN_ENCRYPTION_KEY', 'SALESOS_TOKEN_ENCRYPTION_KEY'))
    google_client_id: str = ''
    google_client_secret: str = ''
    notion_client_id: str = ''
    notion_client_secret: str = ''
    line_channel_secret: str = ''
    line_channel_access_token: str = ''
    internal_api_key: str = ''
    database_path: str = Field(str(ROOT / '.runtime/salesos-dev.sqlite'), validation_alias='SALESOS_DATABASE_PATH')
    max_file_bytes: int = Field(10 * 1024 * 1024, ge=1, le=10 * 1024 * 1024, validation_alias=AliasChoices('SALESOS_MAX_FILE_BYTES', 'MAX_FILE_BYTES'))
    device_max_file_bytes: int | None = Field(None, ge=1, le=10 * 1024 * 1024, validation_alias='SALESOS_DEVICE_MAX_FILE_BYTES')
    max_extract_chars: int = 60000

    @field_validator('openai_model', mode='before')
    @classmethod
    def validate_default_model(cls, value):
        if isinstance(value, str):
            value = value.strip()
            # Existing deployments may still have the previous default in their env.
            if value in {'gpt-4.1-mini', 'gpt-4.1'}:
                return DEFAULT_CHAT_MODEL
            if value in CHAT_MODEL_IDS:
                return value
        raise ValueError('OPENAI_MODEL must be one of: ' + ', '.join(model['id'] for model in CHAT_MODELS))

    @property
    def chat_models(self):
        return [model.copy() for model in CHAT_MODELS]

    def select_chat_model(self, requested=None):
        model = self.openai_model if requested is None else requested
        if not isinstance(model, str) or model not in CHAT_MODEL_IDS:
            raise ValueError('선택한 모델을 사용할 수 없습니다. 모델을 다시 선택해 주세요.')
        return model

    @property
    def device_file_limit(self):
        return min(self.max_file_bytes, self.device_max_file_bytes or self.max_file_bytes)

    @property
    def admins(self):
        return {s.strip().lower() for s in self.admin_emails.split(',') if s.strip()}

    @property
    def google_ready(self):
        return bool(self.google_client_id and self.google_client_secret and self.token_encryption_key)

    @property
    def notion_ready(self):
        return bool(self.notion_client_id and self.notion_client_secret and self.token_encryption_key)

    @property
    def line_ready(self):
        return bool(self.line_channel_secret and self.line_channel_access_token and self.internal_api_key)


settings = Settings()
