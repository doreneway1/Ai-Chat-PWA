import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './ai-chat-proxy.mjs';

const origin = 'https://doreneway1.github.io';
const authorization = 'Bearer test-api-key-123456';

function makeRequest(path, { method = 'POST', headers = {}, body } = {}) {
  return new Request(`https://proxy.example.workers.dev${path}`, {
    method,
    headers: { Origin: origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('answers an allowed browser preflight without contacting the provider', async () => {
  const response = await handleRequest(makeRequest('/api/chat/completions', {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Headers': 'authorization,content-type' }
  }), async () => {
    throw new Error('Preflight must not call provider');
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
});

test('rejects unapproved origins and upstream hosts', async () => {
  const badOrigin = await handleRequest(new Request('https://proxy.example.workers.dev/api/test', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', Authorization: authorization },
    body: JSON.stringify({ baseUrl: 'https://ai.ipeenk.com/v1', model: 'deepseek-v4-pro' })
  }));
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.headers.get('Access-Control-Allow-Origin'), null);

  const badHost = await handleRequest(makeRequest('/api/test', {
    headers: { Authorization: authorization },
    body: { baseUrl: 'https://example.com/v1', model: 'model-x' }
  }), async () => {
    throw new Error('Disallowed upstream must not be fetched');
  });
  assert.equal(badHost.status, 400);
});

test('tests provider credentials and model with a short chat request', async () => {
  let sentUrl;
  let sentInit;
  const response = await handleRequest(makeRequest('/api/test', {
    headers: { Authorization: authorization },
    body: { baseUrl: 'https://ai.ipeenk.com/v1', model: 'deepseek-v4-pro' }
  }), async (url, init) => {
    sentUrl = url.toString();
    sentInit = init;
    return Response.json({
      model: 'deepseek-v4-pro',
      choices: [{ message: { content: 'OK' } }]
    });
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, model: 'deepseek-v4-pro' });
  assert.equal(sentUrl, 'https://ai.ipeenk.com/v1/chat/completions');
  assert.equal(sentInit.headers.Authorization, authorization);
  assert.equal(JSON.parse(sentInit.body).max_tokens, 8);
});

test('allows the configured Kunciai API host', async () => {
  const response = await handleRequest(makeRequest('/api/test', {
    headers: { Authorization: authorization },
    body: { baseUrl: 'https://kunciai.id/v1', model: 'kunciai/deepseek-v4.1-flash' }
  }), async url => {
    assert.equal(url.toString(), 'https://kunciai.id/v1/chat/completions');
    return Response.json({
      model: 'kunciai/deepseek-v4.1-flash',
      choices: [{ message: { content: 'OK' } }]
    });
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, 'kunciai/deepseek-v4.1-flash');
});

test('does not pass the connection test when the provider returns no answer', async () => {
  const response = await handleRequest(makeRequest('/api/test', {
    headers: { Authorization: authorization },
    body: { baseUrl: 'https://ai.ipeenk.com/v1', model: 'deepseek-v4-pro' }
  }), async () => Response.json({
    model: 'deepseek-v4-pro',
    choices: [{ message: { content: '' } }]
  }));

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /format jawaban/i);
});

test('forwards chat requests to the allowlisted provider', async () => {
  const response = await handleRequest(makeRequest('/api/chat/completions', {
    headers: { Authorization: authorization },
    body: {
      baseUrl: 'https://ai.ipeenk.com/v1',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 32
    }
  }), async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).messages, [{ role: 'user', content: 'Hello' }]);
    return Response.json({ choices: [{ message: { content: 'Hi' } }] });
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await response.json()).choices[0].message.content, 'Hi');
});

test('loads provider models using the configured upstream allowlist', async () => {
  let sentUrl;
  const response = await handleRequest(makeRequest('/api/models', {
    headers: { Authorization: authorization },
    body: { baseUrl: 'https://models.example/v1' }
  }), async (url, init) => {
    sentUrl = url.toString();
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, authorization);
    return Response.json({ data: [{ id: 'fast-model' }] });
  }, { ALLOWED_UPSTREAM_HOSTS: 'models.example' });

  assert.equal(response.status, 200);
  assert.equal(sentUrl, 'https://models.example/v1/models');
  assert.deepEqual(await response.json(), { data: [{ id: 'fast-model' }] });
});

test('limits oversized provider model-list responses', async () => {
  const response = await handleRequest(makeRequest('/api/models', {
    headers: { Authorization: authorization },
    body: { baseUrl: 'https://models.example/v1' }
  }), async () => new Response(new Uint8Array(1_000_001)), {
    ALLOWED_UPSTREAM_HOSTS: 'models.example'
  });

  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /terlalu besar/i);
});

test('forwards supported image content and rejects non-image data URLs', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const forwarded = await handleRequest(makeRequest('/api/chat/completions', {
    headers: { Authorization: authorization },
    body: {
      baseUrl: 'https://ai.ipeenk.com/v1',
      model: 'vision-model',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }]
    }
  }), async (_url, init) => {
    assert.equal(JSON.parse(init.body).messages[0].content[0].image_url.url, image);
    return Response.json({ choices: [{ message: { content: 'Image received' } }] });
  });
  assert.equal(forwarded.status, 200);

  const rejected = await handleRequest(makeRequest('/api/chat/completions', {
    headers: { Authorization: authorization },
    body: {
      baseUrl: 'https://ai.ipeenk.com/v1',
      model: 'vision-model',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }]
    }
  }), async () => {
    throw new Error('Invalid image content must not be forwarded');
  });
  assert.equal(rejected.status, 400);
});
