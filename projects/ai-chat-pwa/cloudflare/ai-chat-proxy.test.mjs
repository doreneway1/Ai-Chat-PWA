import test from 'node:test';
import assert from 'node:assert/strict';
import { __clearRateLimitBucketsForTests, handleRequest } from './ai-chat-proxy.mjs';

const origin = 'https://doreneway1.github.io';
const authorization = 'Bearer test-api-key-123456';

function makeRequest(path, { method = 'POST', headers = {}, body } = {}) {
  return new Request(`https://proxy.example.workers.dev${path}`, {
    method,
    headers: { Origin: origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test.beforeEach(() => __clearRateLimitBucketsForTests());

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

const scrapeHtml = `<!doctype html>
<html><head>
<title>Judul Halaman</title>
<meta name="description" content="Deskripsi halaman contoh.">
</head><body>
<nav>Menu navigasi</nav>
<main><h1>Halo Dunia</h1><p>Isi utama halaman &amp; contoh teks.</p><script>var rahasia = 1;</script></main>
<footer>Kaki halaman</footer>
</body></html>`;

function htmlResponse(html, init = {}) {
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    ...init
  });
}

test('scrapes a public page into title, description, and clean text', async () => {
  let sentUrl;
  const response = await handleRequest(makeRequest('/api/scrape', {
    headers: { Authorization: authorization },
    body: { url: 'https://example.com/artikel' }
  }), async url => {
    sentUrl = url.toString();
    return htmlResponse(scrapeHtml);
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(sentUrl, 'https://example.com/artikel');
  assert.equal(payload.title, 'Judul Halaman');
  assert.equal(payload.description, 'Deskripsi halaman contoh.');
  assert.equal(payload.finalUrl, 'https://example.com/artikel');
  assert.match(payload.text, /Halo Dunia/);
  assert.match(payload.text, /Isi utama halaman & contoh teks\./);
  assert.doesNotMatch(payload.text, /rahasia|Menu navigasi|Kaki halaman/);
  assert.equal(payload.truncated, false);
});

test('rejects scrape targets on private or local networks', async () => {
  for (const url of [
    'http://127.0.0.1/admin',
    'http://localhost:8080/',
    'https://192.168.1.10/router',
    'https://169.254.169.254/latest/meta-data',
    'https://intranet/secret',
    'ftp://example.com/file'
  ]) {
    const response = await handleRequest(makeRequest('/api/scrape', {
      headers: { Authorization: authorization },
      body: { url }
    }), async () => {
      throw new Error('Blocked targets must not be fetched');
    });
    assert.equal(response.status, 400, url);
  }
});

test('revalidates redirect targets and refuses private destinations', async () => {
  const response = await handleRequest(makeRequest('/api/scrape', {
    headers: { Authorization: authorization },
    body: { url: 'https://example.com/mulai' }
  }), async () => new Response(null, {
    status: 302,
    headers: { Location: 'http://10.0.0.5/internal' }
  }));

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /privat atau lokal/i);
});

test('follows a public redirect and reports the final URL', async () => {
  const seen = [];
  const response = await handleRequest(makeRequest('/api/scrape', {
    headers: { Authorization: authorization },
    body: { url: 'https://example.com/lama' }
  }), async url => {
    seen.push(url.toString());
    if (seen.length === 1) {
      return new Response(null, { status: 301, headers: { Location: '/baru' } });
    }
    return htmlResponse(scrapeHtml);
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['https://example.com/lama', 'https://example.com/baru']);
  assert.equal((await response.json()).finalUrl, 'https://example.com/baru');
});

test('rejects non-text scrape content and empty extractions', async () => {
  const binary = await handleRequest(makeRequest('/api/scrape', {
    headers: { Authorization: authorization },
    body: { url: 'https://example.com/gambar.png' }
  }), async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'Content-Type': 'image/png' }
  }));
  assert.equal(binary.status, 415);

  const empty = await handleRequest(makeRequest('/api/scrape', {
    headers: { Authorization: authorization },
    body: { url: 'https://example.com/spa' }
  }), async () => htmlResponse('<html><head></head><body><div id="root"></div></body></html>'));
  assert.equal(empty.status, 422);
  assert.match((await empty.json()).error, /tidak memuat teks/i);
});

test('truncates very long scraped text', async () => {
  const longHtml = `<html><head><title>Panjang</title></head><body><main><p>${'kata '.repeat(6000)}</p></main></body></html>`;
  const response = await handleRequest(makeRequest('/api/scrape', {
    headers: { Authorization: authorization },
    body: { url: 'https://example.com/panjang' }
  }), async () => htmlResponse(longHtml));

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.text.length, 20_000);
  assert.equal(payload.truncated, true);
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

test('forwards streaming chat requests and larger token limits', async () => {
  const response = await handleRequest(makeRequest('/api/chat/completions', {
    headers: { Authorization: authorization },
    body: {
      baseUrl: 'https://ai.ipeenk.com/v1',
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Halo' }],
      stream: true,
      max_tokens: 8192
    }
  }), async (_url, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.stream, true);
    assert.equal(sent.max_tokens, 8192);
    assert.match(init.headers.Accept, /text\/event-stream/);
    return new Response('data: {"choices":[{"delta":{"content":"Hai"}}]}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' }
    });
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Hai/);
});

test('searches the web through Brave with the user supplied key', async () => {
  const response = await handleRequest(makeRequest('/api/search', {
    headers: { Authorization: authorization },
    body: { query: 'berita AI hari ini', count: 3, searchApiKey: 'brave-key-123456' }
  }), async (url, init) => {
    assert.equal(url.hostname, 'api.search.brave.com');
    assert.equal(url.searchParams.get('q'), 'berita AI hari ini');
    assert.equal(init.headers['X-Subscription-Token'], 'brave-key-123456');
    return Response.json({ web: { results: [
      { title: '<b>Judul</b>', url: 'https://example.com/berita', description: '<i>Cuplikan</i>', age: '1 jam' }
    ] } });
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.results[0].title, 'Judul');
  assert.equal(payload.results[0].description, 'Cuplikan');
});

test('forwards image generation to the provider image endpoint', async () => {
  const response = await handleRequest(makeRequest('/api/images/generations', {
    headers: { Authorization: authorization },
    body: {
      baseUrl: 'https://ai.ipeenk.com/v1',
      model: 'image-model',
      prompt: 'kota masa depan',
      size: '1024x1792'
    }
  }), async (url, init) => {
    assert.equal(url.toString(), 'https://ai.ipeenk.com/v1/images/generations');
    assert.deepEqual(JSON.parse(init.body), {
      model: 'image-model',
      prompt: 'kota masa depan',
      size: '1024x1792',
      n: 1
    });
    return Response.json({ data: [{ url: 'https://cdn.example/kota.png' }] });
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].url, 'https://cdn.example/kota.png');
});

test('extracts Telegram channel posts from widget message blocks', async () => {
  const telegramHtml = `<html><head><title>Channel Uji</title></head><body>
    <div class="tgme_widget_message_text js-message_text" dir="auto">Pengumuman <b>penting</b><br/>Baris kedua</div>
    <div class="tgme_widget_message_footer"><time datetime="2026-11-20T10:00:00+00:00">10:00</time></div>
  </body></html>`;
  const response = await handleRequest(makeRequest('/api/scrape', {
    headers: { Authorization: authorization },
    body: { url: 'https://t.me/s/channeluji' }
  }), async () => htmlResponse(telegramHtml));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.text, /Postingan 2026-11-20/);
  assert.match(payload.text, /Pengumuman penting\nBaris kedua/);
});

test('clamps out-of-range temperature instead of forwarding it', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: 'ok' } }] });
  };
  const response = await handleRequest(makeRequest('/api/chat/completions', {
    headers: { Authorization: authorization },
    body: {
      baseUrl: 'https://ai.ipeenk.com/v1',
      model: 'qwen3-max',
      messages: [{ role: 'user', content: 'Halo' }],
      temperature: 9
    }
  }), fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(sent.temperature, 2);
});

test('limits oversized provider test responses', async () => {
  const fetchImpl = async () => new Response('x'.repeat(1_000_001), { headers: { 'Content-Type': 'application/json' } });
  const response = await handleRequest(makeRequest('/api/test', {
    headers: { Authorization: authorization },
    body: { baseUrl: 'https://ai.ipeenk.com/v1', model: 'qwen3-max' }
  }), fetchImpl);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /terlalu besar/);
});

test('rate limit membatasi 120 permintaan per menit per IP', async () => {
  const fetchImpl = async () => Response.json({ data: [] });
  const makeRateRequest = () => makeRequest('/api/models', {
    headers: { Authorization: authorization, 'CF-Connecting-IP': '203.0.113.7' },
    body: { baseUrl: 'https://ai.ipeenk.com/v1' }
  });
  for (let i = 0; i < 120; i += 1) {
    const response = await handleRequest(makeRateRequest(), fetchImpl);
    assert.equal(response.status, 200);
  }
  const limited = await handleRequest(makeRateRequest(), fetchImpl);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
});
