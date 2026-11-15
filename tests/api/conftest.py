import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'services' / 'api'))
import pytest
from fastapi.testclient import TestClient
from salesos_api.config import Settings
from salesos_api.main import create_app


@pytest.fixture
def app(tmp_path):
    settings = Settings(_env_file=None, dev_mode=True, database_path=str(tmp_path / 'test.sqlite'),
        supabase_service_key='', supabase_publishable_key='', openai_api_key='',
        token_encryption_key='test-only-key', internal_api_key='internal-test',
        line_channel_secret='line-test-secret', line_channel_access_token='line-test-token')
    application = create_app(settings)
    application.state.files.directory = tmp_path / 'files'
    return application


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


@pytest.fixture
def headers():
    return {'Authorization': 'Bearer salesos-local-dev'}
