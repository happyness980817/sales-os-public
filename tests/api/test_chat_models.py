import asyncio
import json
from types import SimpleNamespace

import pytest

from salesos_api.security import DEV_USER_ID


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


def test_public_model_options_include_configured_default(client, app):
    app.state.chat.settings.openai_model = 'configured-model'
    config = client.get('/api/config').json()
    assert config['default_chat_model'] == 'configured-model'
    assert {item['id'] for item in config['chat_models']} == {'configured-model', 'gpt-4.1-mini', 'gpt-4.1'}
    assert all(set(item) == {'id', 'label', 'description'} for item in config['chat_models'])


@pytest.mark.parametrize('header_model,input_model,expected', [
    ('gpt-4.1', None, 'gpt-4.1'),
    (None, 'gpt-4.1', 'gpt-4.1'),
    ('gpt-4.1-mini', 'gpt-4.1', 'gpt-4.1-mini'),
    (None, None, 'configured-model'),
])
def test_selected_model_reaches_responses_and_usage(app, client, headers, model_calls, header_model, input_model, expected):
    app.state.chat.settings.openai_model = 'configured-model'
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
    (None, 'unknown-model'), (None, ''), (None, ['gpt-4.1']),
    ('gpt-4.1', 'unknown-model'),
])
def test_unavailable_model_is_rejected_before_thread_creation(app, client, headers, model_calls, header_model, input_model):
    selected = {**headers, **({'X-SalesOS-Model': header_model} if header_model is not None else {})}
    response = client.post('/api/chatkit', headers=selected, json=message(input_model))
    assert response.status_code == 400
    assert '모델' in response.json()['detail']
    assert not model_calls
    assert not asyncio.run(app.state.repo.list('threads', DEV_USER_ID))
    assert not asyncio.run(app.state.repo.list('jobs', DEV_USER_ID))
