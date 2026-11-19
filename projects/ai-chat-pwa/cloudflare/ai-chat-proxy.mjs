const ALLOWED_ORIGINS = new Set(['https://doreneway1.github.io']);
const DEFAULT_UPSTREAM_HOSTS = new Set(['ai.ipeenk.com', 'kunciai.id']);
const MAX_BODY_BYTES = 8_000_000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_IMAGE_DATA_LENGTH = 7_000_000;
const MAX_MODEL_RESPONSE_BYTES = 1_000_000;

function corsHeaders(origin) {
  const headers = new Headers({
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  });
  if (ALLOWED_ORIGINS.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  }
  return headers;
}

function jsonResponse(data, status, headers) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { status, headers: responseHeaders });
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateBaseUrl(value, env = {}) {
  if (typeof value !== 'string' || value.length > 500) {
    throw new Error('Base URL tidak valid.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Base URL tidak valid.');
  }

  const path = url.pathname.replace(/\/+$/, '');
  const additionalHosts = (env.ALLOWED_UPSTREAM_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = new Set([...DEFAULT_UPSTREAM_HOSTS, ...additionalHosts]);
  if (
    url.protocol !== 'https:' ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/(^|\/)v1$/.test(path)
  ) {
    throw new Error('Base URL harus HTTPS, berakhiran /v1, dan memakai host API yang diizinkan Worker.');
  }

  return url;
}

function validateModel(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('Model ID atau alias otomatis tidak valid.');
  }
  return value.trim();
}

function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) {
    throw new Error(`Request harus berisi 1 sampai ${MAX_MESSAGES} pesan.`);
  }

  return value.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)) {
      throw new Error('Format pesan tidak valid.');
    }
    if (typeof message.content === 'string') {
      if (message.content.length > MAX_MESSAGE_LENGTH) {
        throw new Error('Isi pesan terlalu panjang.');
      }
      return { role: message.role, content: message.content };
    }
    if (!Array.isArray(message.content) || message.content.length > 12) {
      throw new Error('Format lampiran pesan tidak valid.');
    }

    const content = message.content.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= MAX_MESSAGE_LENGTH) {
        return { type: 'text', text: part.text };
      }
      const imageUrl = part?.type === 'image_url'
        ? (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url)
        : '';
      if (
        typeof imageUrl === 'string' &&
        imageUrl.length <= MAX_IMAGE_DATA_LENGTH &&
        /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(imageUrl)
      ) {
        return { type: 'image_url', image_url: { url: imageUrl } };
      }
      throw new Error('Isi gambar harus berupa JPEG, PNG, atau WebP yang disematkan sebagai data URL.');
    });
    return { role: message.role, content };
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Request tidak valid.';
}

export async function handleRequest(request, fetchImpl = fetch, env = {}) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);
  const isApiRoute = requestUrl.pathname === '/api/test' ||
    requestUrl.pathname === '/api/chat/completions' ||
    requestUrl.pathname === '/api/models';

  if (!ALLOWED_ORIGINS.has(origin)) {
    return jsonResponse({ error: 'Origin aplikasi tidak diizinkan.' }, 403, headers);
  }
  if (!isApiRoute) {
    return jsonResponse({ error: 'Route tidak ditemukan.' }, 404, headers);
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method tidak diizinkan.' }, 405, headers);
  }

  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S{8,}$/i.test(authorization)) {
    return jsonResponse({ error: 'API key Bearer wajib diisi.' }, 401, headers);
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: 'Request terlalu besar.' }, 413, headers);
  }

  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'Request terlalu besar.' }, 413, headers);
    }
    body = JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'Body harus berupa JSON yang valid.' }, 400, headers);
  }

  let upstreamBase;
  let model;
  let messages;
  try {
    upstreamBase = validateBaseUrl(body?.baseUrl, env);
    if (requestUrl.pathname !== '/api/models') model = validateModel(body?.model);
    messages = requestUrl.pathname === '/api/test'
      ? [{ role: 'user', content: 'Reply with OK only.' }]
      : requestUrl.pathname === '/api/chat/completions'
        ? validateMessages(body?.messages)
        : [];
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, headers);
  }

  const upstreamUrl = new URL(
    requestUrl.pathname === '/api/models' ? 'models' : 'chat/completions',
    `${upstreamBase.toString().replace(/\/+$/, '')}/`
  );
  if (requestUrl.pathname === '/api/models') {
    let upstream;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: 'GET',
        headers: {
          Authorization: authorization,
          Accept: 'application/json'
        },
        redirect: 'manual'
      });
    } catch {
      return jsonResponse({ error: 'Worker tidak dapat menjangkau API provider.' }, 502, headers);
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      return jsonResponse({ error: 'API provider mengalihkan request. Gunakan Base URL HTTPS kanonis.' }, 502, headers);
    }
    let modelList;
    try {
      modelList = await readLimitedBody(upstream, MAX_MODEL_RESPONSE_BYTES);
    } catch {
      return jsonResponse({ error: 'Worker gagal membaca daftar model provider.' }, 502, headers);
    }
    if (modelList === null) {
      return jsonResponse({ error: 'Daftar model dari provider terlalu besar.' }, 502, headers);
    }
    const responseHeaders = new Headers(headers);
    responseHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
    return new Response(modelList, { status: upstream.status, headers: responseHeaders });
  }

  const upstreamBody = {
    model,
    messages,
    temperature: requestUrl.pathname === '/api/test' ? 0 : body.temperature
  };
  const maxTokens = requestUrl.pathname === '/api/test' ? 8 : body.max_tokens;
  if (Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 4096) {
    upstreamBody.max_tokens = maxTokens;
  }

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(upstreamBody),
      redirect: 'manual'
    });
  } catch {
    return jsonResponse({
      error: 'Worker tidak dapat menjangkau API provider. Periksa Base URL dan koneksi provider.'
    }, 502, headers);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    return jsonResponse({
      error: 'API provider mengalihkan request. Gunakan Base URL HTTPS kanonis dari provider.'
    }, 502, headers);
  }

  if (requestUrl.pathname === '/api/test') {
    const text = await upstream.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!upstream.ok) {
      const providerError = payload?.error;
      const detail = typeof providerError === 'string'
        ? providerError
        : providerError?.message;
      return jsonResponse({
        error: detail || `Provider membalas dengan HTTP ${upstream.status}. Periksa key, model, dan kuota.`
      }, upstream.status, headers);
    }
    if (
      typeof payload?.choices?.[0]?.message?.content !== 'string' ||
      !payload.choices[0].message.content.trim()
    ) {
      return jsonResponse({ error: 'Provider merespons, tetapi format jawaban tidak sesuai Chat Completions.' }, 502, headers);
    }
    return jsonResponse({
      success: true,
      model: typeof payload.model === 'string' ? payload.model : model
    }, 200, headers);
  }

  const responseHeaders = new Headers(headers);
  responseHeaders.set(
    'Content-Type',
    upstream.headers.get('Content-Type') || 'application/json; charset=utf-8'
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

export default {
  fetch(request, env) {
    return handleRequest(request, fetch, env);
  }
};
