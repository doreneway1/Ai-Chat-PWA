const ALLOWED_ORIGINS = new Set(['https://doreneway1.github.io']);
const DEFAULT_UPSTREAM_HOSTS = new Set(['ai.ipeenk.com', 'kunciai.id']);
const MAX_BODY_BYTES = 8_000_000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_IMAGE_DATA_LENGTH = 7_000_000;
const MAX_MODEL_RESPONSE_BYTES = 1_000_000;
const MAX_SCRAPE_BYTES = 2_000_000;
const MAX_SCRAPE_TEXT_LENGTH = 20_000;
const MAX_SCRAPE_REDIRECTS = 3;
const SCRAPE_TIMEOUT_MS = 10_000;
const SCRAPE_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

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

function scrapeError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseIpv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(part => part <= 255) ? parts : null;
}

function isPrivateOrReservedIpv4([a, b]) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function isBlockedScrapeHostname(rawHostname) {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost') return true;
  if (hostname.includes(':')) return true; // Tolak literal IPv6; cakupan privatnya luas dan jarang dipakai untuk halaman publik.
  if (
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.intranet') ||
    hostname.endsWith('.home.arpa')
  ) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return isPrivateOrReservedIpv4(ipv4);
  // Nama host satu label menyerupai host intranet; situs publik selalu memakai domain bertitik.
  // Catatan batasan: Worker tidak dapat memeriksa hasil DNS, jadi nama publik yang
  // diarahkan ke IP privat oleh pemilik DNS-nya tidak dapat dideteksi di lapisan ini.
  return !hostname.includes('.');
}

export function validateScrapeUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    throw scrapeError('URL halaman tidak valid.', 400);
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw scrapeError('URL halaman tidak valid.', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw scrapeError('URL halaman harus memakai HTTP atau HTTPS.', 400);
  }
  if (url.username || url.password) {
    throw scrapeError('URL halaman tidak boleh memuat kredensial.', 400);
  }
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) {
    throw scrapeError('URL halaman harus memakai port standar.', 400);
  }
  if (isBlockedScrapeHostname(url.hostname)) {
    throw scrapeError('URL menuju jaringan privat atau lokal tidak diizinkan.', 400);
  }
  return url;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function readMetaContent(html, wantedKeys) {
  const metaTagPattern = /<meta\b[^>]*>/gi;
  let tag;
  while ((tag = metaTagPattern.exec(html)) !== null) {
    const attrs = {};
    const attrPattern = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attr;
    while ((attr = attrPattern.exec(tag[0])) !== null) {
      attrs[attr[1].toLowerCase()] = attr[3] ?? attr[4] ?? '';
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (wantedKeys.includes(key) && attrs.content) {
      return decodeHtmlEntities(attrs.content).trim();
    }
  }
  return '';
}

function normalizeExtractedText(text) {
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function extractPageContent(html, contentType = 'text/html') {
  if (contentType === 'text/plain') {
    return { title: '', description: '', text: normalizeExtractedText(html) };
  }
  const title =
    readMetaContent(html, ['og:title', 'twitter:title']) ||
    decodeHtmlEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/<[^>]+>/g, '')).trim();
  const description = readMetaContent(html, ['description', 'og:description', 'twitter:description']);

  // Halaman pratinjau channel Telegram (t.me/s/...) memuat postingan sebagai
  // blok tgme_widget_message_text. Ekstrak blok itu secara khusus agar hasil
  // tidak tercampur label media, jumlah views, dan navigasi Telegram.
  if (html.includes('tgme_widget_message_text')) {
    const posts = [];
    const textPattern = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let match;
    while ((match = textPattern.exec(html)) !== null) {
      const cleaned = normalizeExtractedText(decodeHtmlEntities(
        match[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
      ));
      if (!cleaned) continue;
      const nearby = html.slice(match.index, match.index + 5000);
      const datetime = /<time[^>]*datetime="([^"]+)"/i.exec(nearby)?.[1] || '';
      posts.push(datetime ? `[Postingan ${datetime}]\n${cleaned}` : cleaned);
      if (posts.length >= 30) break;
    }
    if (posts.length) return { title, description, text: posts.join('\n\n') };
  }

  const mainMatch =
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html) ||
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html) ||
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  let fragment = mainMatch ? mainMatch[1] : html;
  fragment = fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|iframe|svg|form|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = normalizeExtractedText(decodeHtmlEntities(fragment));
  return { title, description, text: text || description };
}

async function scrapeSingleUrl(value, fetchImpl) {
  const target = validateScrapeUrl(value);
  let currentUrl = target;
  for (let hop = 0; hop <= MAX_SCRAPE_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          'User-Agent': 'dorenewAI-LinkReader/1.0'
        },
        redirect: 'manual',
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(SCRAPE_TIMEOUT_MS)
          : undefined
      });
    } catch {
      throw scrapeError('Worker tidak dapat menjangkau halaman tersebut.', 502);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      try { await response.body?.cancel(); } catch { /* abaikan */ }
      if (!location) {
        throw scrapeError('Halaman mengalihkan request tanpa tujuan yang jelas.', 502);
      }
      if (hop === MAX_SCRAPE_REDIRECTS) {
        throw scrapeError('Halaman terlalu banyak mengalihkan request.', 502);
      }
      let next;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw scrapeError('Tujuan pengalihan halaman tidak valid.', 502);
      }
      currentUrl = validateScrapeUrl(next.toString());
      continue;
    }

    if (!response.ok) {
      throw scrapeError(`Situs membalas HTTP ${response.status}; halaman tidak dapat dibaca.`, 502);
    }

    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!SCRAPE_CONTENT_TYPES.has(contentType)) {
      throw scrapeError('Isi tautan bukan halaman HTML atau teks yang dapat dibaca.', 415);
    }

    const rawBody = await readLimitedBody(response, MAX_SCRAPE_BYTES);
    if (rawBody === null) {
      throw scrapeError('Halaman terlalu besar untuk dibaca.', 413);
    }

    const { title, description, text } = extractPageContent(rawBody, contentType);
    if (!text && !description) {
      throw scrapeError('Halaman tidak memuat teks yang dapat dibaca; mungkin kontennya dimuat dengan JavaScript atau memerlukan login.', 422);
    }
    const truncated = text.length > MAX_SCRAPE_TEXT_LENGTH;
    return {
      title,
      description,
      url: target.toString(),
      finalUrl: currentUrl.toString(),
      text: truncated ? text.slice(0, MAX_SCRAPE_TEXT_LENGTH) : text,
      truncated,
      fetchedAt: Date.now()
    };
  }
  throw scrapeError('Halaman terlalu banyak mengalihkan request.', 502);
}

const TELEGRAM_RESERVED_PATHS = new Set([
  's', 'joinchat', 'addstickers', 'addemoji', 'share', 'iv', 'login',
  'setlanguage', 'proxy', 'socks', 'bg', 'boost', 'giftcode', 'wallet'
]);

export function telegramScrapeCandidates(url) {
  if (!['t.me', 'www.t.me'].includes(url.hostname.toLowerCase())) return [url.toString()];
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return [url.toString()];
  const username = segments[0];
  if (!/^[A-Za-z0-9_]{4,}$/.test(username) || TELEGRAM_RESERVED_PATHS.has(username.toLowerCase())) {
    return [url.toString()];
  }
  // Untuk channel publik, /s/<username> memuat postingan terbaru; untuk grup,
  // Telegram mengembalikan pratinjau yang sama, jadi urutan ini aman dicoba.
  return [`https://t.me/s/${username}`, url.toString()];
}

async function scrapeUrl(value, fetchImpl) {
  const target = validateScrapeUrl(value);
  const candidates = telegramScrapeCandidates(target);
  let lastError;
  for (const candidate of candidates) {
    try {
      return await scrapeSingleUrl(candidate, fetchImpl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || scrapeError('Halaman tidak dapat dibaca.', 502);
}

function validateSearchApiKey(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 300 || /\s/.test(value)) {
    throw new Error('Brave Search API key tidak valid.');
  }
  return value;
}

async function searchWeb(body, fetchImpl) {
  const query = typeof body?.query === 'string' ? body.query.trim().replace(/\s+/g, ' ') : '';
  if (query.length < 2 || query.length > 500) throw new Error('Kueri pencarian harus 2 sampai 500 karakter.');
  const count = Number.isInteger(body?.count) ? Math.min(10, Math.max(1, body.count)) : 5;
  const apiKey = validateSearchApiKey(body?.searchApiKey);
  const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('count', String(count));
  endpoint.searchParams.set('safesearch', 'moderate');
  endpoint.searchParams.set('search_lang', 'id');
  let upstream;
  try {
    upstream = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey
      }
    });
  } catch {
    const error = new Error('Worker tidak dapat menjangkau Brave Search.');
    error.status = 502;
    throw error;
  }
  const raw = await readLimitedBody(upstream, MAX_MODEL_RESPONSE_BYTES);
  if (raw === null) {
    const error = new Error('Hasil pencarian terlalu besar.');
    error.status = 502;
    throw error;
  }
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
  if (!upstream.ok) {
    const detail = payload?.errors?.[0]?.detail || payload?.message || `Brave Search membalas HTTP ${upstream.status}.`;
    const error = new Error(detail);
    error.status = upstream.status === 401 || upstream.status === 403 ? 401 : 502;
    throw error;
  }
  const results = (Array.isArray(payload?.web?.results) ? payload.web.results : [])
    .map(result => ({
      title: typeof result?.title === 'string' ? result.title.replace(/<[^>]+>/g, '').slice(0, 300) : '',
      url: typeof result?.url === 'string' ? result.url.slice(0, 2048) : '',
      description: typeof result?.description === 'string' ? result.description.replace(/<[^>]+>/g, '').slice(0, 1200) : '',
      age: typeof result?.age === 'string' ? result.age.slice(0, 100) : ''
    }))
    .filter(result => result.url && (result.title || result.description))
    .slice(0, count);
  return { query, results, fetchedAt: Date.now() };
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
    requestUrl.pathname === '/api/models' ||
    requestUrl.pathname === '/api/scrape' ||
    requestUrl.pathname === '/api/search' ||
    requestUrl.pathname === '/api/images/generations';

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

  if (requestUrl.pathname === '/api/scrape') {
    try {
      const result = await scrapeUrl(body?.url, fetchImpl);
      return jsonResponse(result, 200, headers);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      return jsonResponse({ error: errorMessage(error) }, status, headers);
    }
  }

  if (requestUrl.pathname === '/api/search') {
    try {
      const result = await searchWeb(body, fetchImpl);
      return jsonResponse(result, 200, headers);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      return jsonResponse({ error: errorMessage(error) }, status, headers);
    }
  }

  let upstreamBase;
  let model;
  let messages;
  let imagePrompt = '';
  let imageSize = '1024x1024';
  try {
    upstreamBase = validateBaseUrl(body?.baseUrl, env);
    if (requestUrl.pathname !== '/api/models') model = validateModel(body?.model);
    if (requestUrl.pathname === '/api/images/generations') {
      imagePrompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
      if (!imagePrompt || imagePrompt.length > 4000) {
        throw new Error('Prompt gambar harus 1 sampai 4000 karakter.');
      }
      const allowedSizes = new Set(['1024x1024', '1024x1792', '1792x1024', '512x512']);
      imageSize = allowedSizes.has(body?.size) ? body.size : '1024x1024';
    }
    messages = requestUrl.pathname === '/api/test'
      ? [{ role: 'user', content: 'Reply with OK only.' }]
      : requestUrl.pathname === '/api/chat/completions'
        ? validateMessages(body?.messages)
        : [];
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400, headers);
  }

  const upstreamUrl = new URL(
    requestUrl.pathname === '/api/models'
      ? 'models'
      : requestUrl.pathname === '/api/images/generations'
        ? 'images/generations'
        : 'chat/completions',
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

  const isImageRequest = requestUrl.pathname === '/api/images/generations';
  const wantsStream = !isImageRequest && requestUrl.pathname === '/api/chat/completions' && body.stream === true;
  const upstreamBody = isImageRequest
    ? { model, prompt: imagePrompt, size: imageSize, n: 1 }
    : {
        model,
        messages,
        temperature: requestUrl.pathname === '/api/test' ? 0 : body.temperature,
        ...(wantsStream ? { stream: true } : {})
      };
  if (!isImageRequest) {
    const maxTokens = requestUrl.pathname === '/api/test' ? 8 : body.max_tokens;
    if (Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 16384) {
      upstreamBody.max_tokens = maxTokens;
    }
  }

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        Accept: wantsStream ? 'text/event-stream, application/json' : 'application/json'
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
