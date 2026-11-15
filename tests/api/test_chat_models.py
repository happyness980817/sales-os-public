import asyncio
import base64
import hashlib
import hmac
import json
from types import SimpleNamespace

import pytest

from salesos_api.security import DEV_USER_ID
from salesos_api.config import Settings


MODEL_LABELS = {
    'gpt-6-astra': 'GPT-6 Astra',
    'gpt-6.1-sol': 'GPT-6.1 Sol',
    'gpt-6.1-terra': 'GPT-6.1 Terra',
    'gpt-6-luna': 'GPT-6 Luna',
}


@pytest.fixture
def model_calls(app, monkeypatch):
    calls = []

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.responses = self

        async def create(self, **kwargs):
            calls.append(kwargs)

            async def events():
                yield SimpleNamespace(type='response.output_text.delta', delta='확인했습니다.')
                yield SimpleNamespace(type='response.completed', response=SimpleNamespace(
                    output=[], usage=SimpleNamespace(input_tokens=7, output_tokens=3)))
            return events()

        async def close(self):
            pass

    monkeypatch.setattr('salesos_api.chat.AsyncOpenAI', FakeOpenAI)
    app.state.chat.settings.openai_api_key = 'fixture-never-sent'
    return calls


def message(model=None):
    return {'type': 'threads.create', 'params': {'input': {
        'content': [{'type': 'input_text', 'text': '선택한 모델로 답해주세요.'}],
        'attachments': [], 'inference_options': {} if model is None else {'model': model},
    }}}


def test_public_model_options_are_the_four_supported_models(client, app):
    config = client.get('/api/config').json()
    assert config['default_chat_model'] == 'gpt-6.1-sol'
    assert {item['id']: item['label'] for item in config['chat_models']} == MODEL_LABELS
    assert len(config['chat_models']) == 4
    assert all(set(item) == {'id', 'label', 'description'} for item in config['chat_models'])
    app.state.chat.settings.openai_model = 'gpt-6-luna'
    assert client.get('/api/config').json()['default_chat_model'] == 'gpt-6-luna'
    assert client.get('/api/config').json()['chat_models'] == config['chat_models']


@pytest.mark.parametrize('configured,expected', [
    *((model, model) for model in MODEL_LABELS),
    ('  gpt-6.1-terra  ', 'gpt-6.1-terra'),
    ('gpt-4.1-mini', 'gpt-6.1-sol'),
    ('gpt-4.1', 'gpt-6.1-sol'),
])
def test_model_environment_accepts_supported_ids_and_migrates_legacy_defaults(monkeypatch, configured, expected):
    monkeypatch.setenv('OPENAI_MODEL', configured)
    settings = Settings(_env_file=None)
    assert settings.openai_model == expected
    assert settings.select_chat_model() == expected
    assert len(settings.chat_models) == 4


@pytest.mark.parametrize('configured', ['unknown-model', 'gpt-6.1-luna', '', '   '])
def test_invalid_default_model_is_rejected_from_configuration_and_assignment(monkeypatch, configured):
    monkeypatch.setenv('OPENAI_MODEL', configured)
    with pytest.raises(ValueError):
        Settings(_env_file=None)
    settings = Settings(_env_file=None, openai_model='gpt-6.1-sol')
    with pytest.raises(ValueError):
        settings.openai_model = configured
    assert settings.openai_model == 'gpt-6.1-sol'


@pytest.mark.parametrize('header_model,input_model,expected', [
    *((model, None, model) for model in MODEL_LABELS),
    *((None, model, model) for model in MODEL_LABELS),
    ('gpt-6.1-terra', 'gpt-6-astra', 'gpt-6.1-terra'),
    (None, None, 'gpt-6.1-sol'),
])
def test_selected_model_reaches_responses_and_usage(app, client, headers, model_calls, header_model, input_model, expected):
    selected = {**headers, **({'X-SalesOS-Model': header_model} if header_model is not None else {})}
    response = client.post('/api/chatkit', headers=selected, json=message(input_model))
    assert response.status_code == 200
    events = [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith('data:')]
    assert any(item['type'] == 'thread.item.done' for item in events)
    assert [call['model'] for call in model_calls] == [expected]
    usage = asyncio.run(app.state.repo.list('usage', DEV_USER_ID))
    assert len(usage) == 1
    assert usage[0]['data']['model'] == expected
    assert usage[0]['data']['input_tokens'] == 7
    assert usage[0]['data']['output_tokens'] == 3


@pytest.mark.parametrize('header_model,input_model', [
    ('unknown-model', None), ('', None),
    (None, 'unknown-model'), (None, ''), (None, ['gpt-6.1-sol']),
    ('gpt-6.1-sol', 'unknown-model'),
    ('gpt-4.1-mini', None), (None, 'gpt-4.1-mini'),
    ('gpt-4.1', None), (None, 'gpt-4.1'),
    ('gpt-6.1-luna', None), (None, 'gpt-6.1-luna'),
])
def test_unavailable_model_is_rejected_before_thread_creation(app, client, headers, model_calls, header_model, input_model):
    selected = {**headers, **({'X-SalesOS-Model': header_model} if header_model is not None else {})}
    response = client.post('/api/chatkit', headers=selected, json=message(input_model))
    assert response.status_code == 400
    assert '모델' in response.json()['detail']
    assert not model_calls
    assert not asyncio.run(app.state.repo.list('threads', DEV_USER_ID))
    assert not asyncio.run(app.state.repo.list('jobs', DEV_USER_ID))


@pytest.mark.parametrize('default_model', ['gpt-6.1-sol', 'gpt-6-luna'])
def test_line_conversation_uses_configured_default_and_records_usage(app, client, headers, model_calls, default_model):
    app.state.chat.settings.openai_model = default_model
    code = client.post('/api/line/link-code', headers=headers).json()['code']
    internal = {'Authorization': 'Bearer internal-test', 'Content-Type': 'application/json'}

    def send_event(event_id, text):
        raw = json.dumps({'events': [{'type': 'message', 'webhookEventId': event_id,
            'source': {'type': 'user', 'userId': 'U_model_test'},
            'message': {'type': 'text', 'text': text}}]}).encode()
        signature = base64.b64encode(hmac.new(b'line-test-secret', raw, hashlib.sha256).digest()).decode()
        response = client.post('/api/internal/line/events', content=raw,
                               headers={**internal, 'X-Line-Signature': signature})
        assert response.status_code == 200 and response.json()['accepted'] == 1

    send_event('model_link', '연결 ' + code)
    send_event('model_question', '오늘 할 일을 알려주세요.')
    response = client.post('/api/internal/reconcile', headers=internal)
    assert response.status_code == 200 and response.json()['processed'] == 1
    assert [call['model'] for call in model_calls] == [default_model]
    usage = asyncio.run(app.state.repo.list('usage', DEV_USER_ID))
    assert len(usage) == 1 and usage[0]['data']['model'] == default_model
    outgoing = asyncio.run(app.state.repo.list('line_outbound', DEV_USER_ID))
    assert any(row['data']['messages'] == [{'type': 'text', 'text': '확인했습니다.'}] for row in outgoing)
