const ALLOWED_ORIGINS = new Set(['https://doreneway1.github.io']);
const ALLOWED_UPSTREAM_HOSTS = new Set(['ai.ipeenk.com']);
const MAX_BODY_BYTES = 512_000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 100_000;

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

function validateBaseUrl(value) {
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
  if (
    url.protocol !== 'https:' ||
    !ALLOWED_UPSTREAM_HOSTS.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/(^|\/)v1$/.test(path)
  ) {
    throw new Error('Base URL harus HTTPS, berakhiran /v1, dan memakai host API yang diizinkan Worker.');
  }

  url.pathname = `${path}/chat/completions`;
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
    if (
      !message ||
      !['system', 'user', 'assistant'].includes(message.role) ||
      typeof message.content !== 'string' ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      throw new Error('Format pesan tidak valid.');
    }
    return { role: message.role, content: message.content };
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Request tidak valid.';
}

export async function handleRequest(request, fetchImpl = fetch) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);
  const isApiRoute = requestUrl.pathname === '/api/test' ||
    requestUrl.pathname === '/api/chat/completions';

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

  let upstreamUrl;
  let model;
  let messages;
  try {
    upstreamUrl = validateBaseUrl(body?.baseUrl);
    model = validateModel(body?.model);
    messages = requestUrl.pathname === '/api/test'
      ? [{ role: 'user', content: 'Reply with OK only.' }]
      : validateMessages(body?.messages);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, headers);
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
  fetch(request) {
    return handleRequest(request);
  }
};
