from pathlib import Path
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(ROOT / '.env', ROOT / '.runtime/server.env'), extra='ignore', populate_by_name=True)
    supabase_url: str = ''
    supabase_publishable_key: str = ''
    supabase_service_key: str = Field('', validation_alias=AliasChoices('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'))
    openai_api_key: str = ''
    openai_model: str = 'gpt-4.1-mini'
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

    @property
    def chat_models(self):
        options = [
            {'id': 'gpt-4.1-mini', 'label': 'GPT-4.1 mini', 'description': '일상적인 업무와 빠른 답변'},
            {'id': 'gpt-4.1', 'label': 'GPT-4.1', 'description': '복잡한 자료 분석과 상세한 답변'},
        ]
        if self.openai_model not in {item['id'] for item in options}:
            options.insert(0, {'id': self.openai_model, 'label': self.openai_model, 'description': '관리자가 설정한 기본 모델'})
        return options

    def select_chat_model(self, requested=None):
        model = self.openai_model if requested is None else requested
        if not isinstance(model, str) or model not in {item['id'] for item in self.chat_models}:
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
