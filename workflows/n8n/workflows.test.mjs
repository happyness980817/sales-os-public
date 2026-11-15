import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { test } from 'node:test';

const load = async name => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'));
const ingress = await load('01-line-ingress.json');
const reconcile = await load('02-reconcile.json');
const outbound = await load('03-line-outbound.json');
const code = (workflow, name) => workflow.nodes.find(n => n.name === name).parameters.jsCode;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function execute(workflow, name, item, { raw, previous = {}, runIndex = 0 } = {}) {
  const fn = new AsyncFunction('$input', '$', '$runIndex', code(workflow, name));
  return fn.call({ helpers: { getBinaryDataBuffer: async (index, property) => {
    assert.equal(index, 0); assert.equal(property, 'data');
    if (!raw) throw new Error('Missing binary');
    return raw;
  } } }, { first: () => item }, node => ({
    first: (_branch = 0, run = 0) => ({ json: Array.isArray(previous[node]) ? previous[node][run] : previous[node] })
  }), runIndex);
}
const fixtureMessage = {
  id: 'a'.repeat(64), to: 'U' + 'b'.repeat(32),
  messages: [{ type: 'text', text: '합성 테스트 응답입니다.' }],
  retry_key: '00000000-0000-5000-8000-000000000001',
  lease_token: 'fixture_lease_token_1234567890',
};
const config = { api_base: 'https://salesos.example.invalid' };

test('import documents are inactive, connected, standard-node-only and contain credential references only', () => {
  const supported = new Set(['webhook', 'code', 'if', 'httpRequest', 'respondToWebhook', 'scheduleTrigger', 'wait']);
  for (const workflow of [ingress, reconcile, outbound]) {
    assert.equal(workflow.active, false);
    assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
    assert.equal(workflow.settings.saveDataErrorExecution, 'none');
    assert.deepEqual(workflow.pinData, {});
    const names = new Set(workflow.nodes.map(n => n.name));
    assert.equal(names.size, workflow.nodes.length);
    assert.equal(new Set(workflow.nodes.map(n => n.id)).size, workflow.nodes.length);
    for (const [source, value] of Object.entries(workflow.connections)) {
      assert.ok(names.has(source));
      for (const branch of value.main) for (const edge of branch) assert.ok(names.has(edge.node));
    }
    for (const node of workflow.nodes) {
      assert.ok(supported.has(node.type.replace('n8n-nodes-base.', '')));
      if (node.type.endsWith('.code')) new AsyncFunction('$input', '$', node.parameters.jsCode);
      if (node.type.endsWith('.httpRequest')) {
        assert.equal(node.parameters.options.redirect.redirect.followRedirects, false);
        assert.equal(node.parameters.genericAuthType, 'httpHeaderAuth');
        const credential = node.credentials.httpHeaderAuth;
        assert.deepEqual(Object.keys(credential).sort(), ['id', 'name']);
        assert.ok(credential.id.startsWith('REPLACE_WITH_'));
      }
    }
  }
});

test('raw UTF-8 bytes survive base64 wrapping without JSON normalization and retain HMAC', async () => {
  const raw = Buffer.from('{\r\n  "destination": "fixture", "events": [], "note": "미팅 🗓️"\r\n}\n');
  const signature = crypto.createHmac('sha256', 'synthetic-fixture-secret').update(raw).digest('base64');
  const item = { json: { ...config, headers: { 'x-line-signature': signature }, body: { deliberately: 'different parsed body' } }, binary: { data: {} } };
  const [prepared] = await execute(ingress, 'Preserve LINE raw bytes', item, { raw });
  assert.equal(prepared.json.forward, true);
  const wire = JSON.parse(JSON.stringify(prepared.json.envelope));
  assert.deepEqual(Buffer.from(wire.raw_body_base64, 'base64'), raw);
  const recalculated = crypto.createHmac('sha256', 'synthetic-fixture-secret').update(Buffer.from(wire.raw_body_base64, 'base64')).digest('base64');
  assert.equal(wire.signature, recalculated);
  const forward = ingress.nodes.find(n => n.name === 'Verify and store event');
  assert.equal(forward.parameters.sendHeaders, undefined, 'wrapper must not also send X-Line-Signature');
  assert.equal(ingress.nodes.find(n => n.name === 'LINE webhook').parameters.options.rawBody, true);
});

test('missing signature, missing raw bytes and oversized payload fail closed', async () => {
  const [unsigned] = await execute(ingress, 'Preserve LINE raw bytes', { json: { headers: {} } });
  assert.equal(unsigned.json.forward, false); assert.equal(unsigned.json.statusCode, 401);
  const item = { json: { headers: { 'x-line-signature': 'a'.repeat(43) + '=' } } };
  const [missing] = await execute(ingress, 'Preserve LINE raw bytes', item);
  assert.equal(missing.json.forward, false); assert.equal(missing.json.statusCode, 500);
  const [large] = await execute(ingress, 'Preserve LINE raw bytes', { ...item, binary: { data: {} } }, { raw: Buffer.alloc(1000001) });
  assert.equal(large.json.forward, false); assert.equal(large.json.statusCode, 413);
});

test('webhook acknowledgement reflects verified acceptance and upstream failures', async () => {
  const run = async value => (await execute(ingress, 'Map webhook result', { json: value }))[0].json;
  assert.equal((await run({ statusCode: 200, body: { ok: true } })).statusCode, 200);
  assert.equal((await run({ statusCode: 200, body: {} })).statusCode, 503);
  assert.equal((await run({ statusCode: 401, body: { detail: 'private' } })).statusCode, 401);
  assert.deepEqual(await run({ error: 'network details must not leak' }), { statusCode: 503, responseBody: { ok: false, error: 'event_not_accepted' }, processWork: false });
});

test('empty outbox stops and valid backend mapping is unchanged; malformed mapping is rejected', async () => {
  assert.deepEqual(await execute(outbound, 'Validate claimed message', { json: { message: null } }), []);
  const [valid] = await execute(outbound, 'Validate claimed message', { json: { message: fixtureMessage } }, { previous: { 'Configure SALES-OS URL': config } });
  assert.deepEqual(valid.json.message, fixtureMessage);
  await assert.rejects(execute(outbound, 'Validate claimed message', { json: { message: { ...fixtureMessage, to: 'invented-recipient' } } }), /Invalid backend outbox contract/);
  await assert.rejects(execute(outbound, 'Validate claimed message', { json: {} }), /Invalid backend outbox contract/);
});

test('LINE acceptance distinguishes success, deduplicated success, failure and lost response', async () => {
  const run = async response => (await execute(outbound, 'Record LINE acceptance', { json: response }, { previous: { 'Validate claimed message': { ...config, message: fixtureMessage } } }))[0].json;
  for (const response of [
    { statusCode: 200, headers: {} },
    { statusCode: 409, headers: { 'x-line-accepted-request-id': 'fixture-request' } },
  ]) {
    const record = await run(response);
    assert.equal(record.result.accepted, true);
    assert.equal(record.result.lease_token, fixtureMessage.lease_token);
    assert.equal(record.id, fixtureMessage.id);
  }
  for (const response of [{ statusCode: 409 }, { statusCode: 429 }, { statusCode: 500 }, { error: 'timeout' }]) {
    assert.equal((await run(response)).result.accepted, false);
  }
  const push = outbound.nodes.find(n => n.name === 'Push claimed message to LINE');
  assert.equal(push.retryOnFail, false);
  assert.equal(push.parameters.headerParameters.parameters[0].name, 'X-Line-Retry-Key');
  assert.equal(push.parameters.headerParameters.parameters[0].value, '={{ $json.message.retry_key }}');
});

test('reconcile response validates count without claiming every processed job succeeded', async () => {
  assert.deepEqual(await execute(reconcile, 'Validate reconcile result', { json: { processed: 0, busy: true } }), [{ json: { processed: 0, busy: true } }]);
  assert.deepEqual(await execute(reconcile, 'Validate reconcile result', { json: { processed: 3 } }), [{ json: { processed: 3, busy: false } }]);
  await assert.rejects(execute(reconcile, 'Validate reconcile result', { json: { processed: 4 } }));
});

test('normal workflow is event-driven, acknowledges before work and has no timer or child execution', () => {
  assert.ok(!ingress.nodes.some(n => n.type.endsWith('.scheduleTrigger') || n.type.endsWith('.executeWorkflow')));
  assert.equal(ingress.connections['Respond to LINE'].main[0][0].node, 'Continue accepted event');
  assert.equal(ingress.connections['Continue accepted event'].main[0][0].node, 'Process queued jobs');
  assert.equal(ingress.connections['Queue needs another pass'].main[1][0].node, 'Claim one outbound message');
  assert.equal(ingress.nodes.find(n => n.name === 'Respond to LINE').parameters.enableResponseOutput, false);
  assert.equal(ingress.settings.executionTimeout, 300);
  for (const workflow of [reconcile, outbound]) {
    assert.equal(workflow.active, false);
    assert.match(workflow.name, /RECOVERY ONLY/);
    const trigger = workflow.nodes.find(n => n.type.endsWith('.scheduleTrigger'));
    assert.deepEqual(trigger.parameters.rule.interval, [{ field: 'minutes', minutesInterval: 30 }]);
  }
});

test('empty or ignored events acknowledge without queue processing; accepted and duplicate events continue', async () => {
  for (const counts of [{ accepted: 0, duplicates: 0, ignored: 0 }, { accepted: 0, duplicates: 0, ignored: 1 }]) {
    const [mapped] = await execute(ingress, 'Map webhook result', { json: { statusCode: 200, body: { ok: true, ...counts } } });
    assert.equal(mapped.json.statusCode, 200);
    assert.equal(mapped.json.processWork, false);
    assert.deepEqual(await execute(ingress, 'Continue accepted event', mapped), []);
  }
  for (const counts of [{ accepted: 1, duplicates: 0 }, { accepted: 0, duplicates: 1 }]) {
    const [mapped] = await execute(ingress, 'Map webhook result', { json: { statusCode: 200, body: { ok: true, ...counts } } });
    const continued = await execute(ingress, 'Continue accepted event', mapped, { previous: { 'Configure SALES-OS URL': config } });
    assert.deepEqual(continued, [{ json: config }]);
  }
  assert.deepEqual(await execute(ingress, 'Continue accepted event', { json: { statusCode: 401, processWork: true } }), []);
});

test('busy or full reconcile batch retries only inside a bounded existing execution', async () => {
  for (const response of [{ processed: 0, busy: true }, { processed: 3 }]) {
    const [reviewed] = await execute(ingress, 'Review queued work', { json: response }, { previous: { 'Configure SALES-OS URL': config }, runIndex: 11 });
    assert.equal(reviewed.json.retry_reconcile, true);
    await assert.rejects(execute(ingress, 'Review queued work', { json: response }, { runIndex: 12 }), /Queue processing limit/);
  }
  const [ready] = await execute(ingress, 'Review queued work', { json: { processed: 0 } }, { previous: { 'Configure SALES-OS URL': config } });
  assert.equal(ready.json.retry_reconcile, false);
  assert.deepEqual(ingress.nodes.find(n => n.name === 'Wait 5 seconds within execution').parameters, { resume: 'timeInterval', amount: 5, unit: 'seconds' });
});

test('outbox loop uses the current claim lease and never the previous recipient', async () => {
  const second = { ...fixtureMessage, id: 'c'.repeat(64), to: 'U' + 'd'.repeat(32), lease_token: 'second_fixture_lease_token_1234' };
  const [record] = await execute(ingress, 'Record LINE acceptance', { json: { statusCode: 200 } }, {
    previous: { 'Validate claimed message': [{ ...config, message: fixtureMessage }, { ...config, message: second }] }, runIndex: 1,
  });
  assert.equal(record.json.id, second.id);
  assert.equal(record.json.result.lease_token, second.lease_token);
  assert.notEqual(record.json.result.lease_token, fixtureMessage.lease_token);
  assert.deepEqual(await execute(ingress, 'Validate claimed message', { json: { message: null } }), []);
  assert.deepEqual(await execute(ingress, 'Continue bounded outbox drain', { json: {} }, { runIndex: 9 }), []);
  assert.deepEqual(await execute(ingress, 'Continue bounded outbox drain', { json: {} }, { previous: { 'Configure SALES-OS URL': config }, runIndex: 0 }), [{ json: config }]);
  await assert.rejects(execute(ingress, 'Validate acknowledgement', { json: { ok: true, status: 'pending' } }), /LINE did not accept/);
});

test('synthetic normal path acknowledges before reconcile and delivers within the same workflow', async () => {
  const observed = [];
  const [ack] = await execute(ingress, 'Map webhook result', { json: { statusCode: 200, body: { ok: true, accepted: 1, duplicates: 0, ignored: 0 } } });
  // Model Respond to Webhook's documented input-forwarding output; this is not a live n8n engine test.
  observed.push('ACK ' + ack.json.statusCode);
  const [continued] = await execute(ingress, 'Continue accepted event', ack, { previous: { 'Configure SALES-OS URL': config } });
  assert.deepEqual(continued.json, config);
  observed.push('reconcile');
  const [review] = await execute(ingress, 'Review queued work', { json: { processed: 1 } }, { previous: { 'Configure SALES-OS URL': config } });
  assert.equal(review.json.retry_reconcile, false);
  observed.push('claim');
  const [claimed] = await execute(ingress, 'Validate claimed message', { json: { message: fixtureMessage } }, { previous: { 'Configure SALES-OS URL': config } });
  assert.equal(claimed.json.message.to, fixtureMessage.to);
  observed.push('push');
  const [record] = await execute(ingress, 'Record LINE acceptance', { json: { statusCode: 200 } }, { previous: { 'Validate claimed message': claimed.json } });
  assert.deepEqual(record.json.result, { accepted: true, lease_token: fixtureMessage.lease_token });
  observed.push('result');
  await execute(ingress, 'Validate acknowledgement', { json: { ok: true, status: 'succeeded' } });
  assert.deepEqual(observed, ['ACK 200', 'reconcile', 'claim', 'push', 'result']);
});

test('Cloud Starter five-minute execution limit is explicit and HTTP calls have smaller timeouts', () => {
  for (const workflow of [ingress, reconcile, outbound]) {
    assert.equal(workflow.settings.executionTimeout, 300);
    for (const node of workflow.nodes.filter(n => n.type.endsWith('.httpRequest'))) {
      const expected = node.name === 'Process queued jobs' ? 120000 : 10000;
      assert.equal(node.parameters.options.timeout, expected);
      assert.ok(node.parameters.options.timeout < workflow.settings.executionTimeout * 1000);
    }
  }
});
