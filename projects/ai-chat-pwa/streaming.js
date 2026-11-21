function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return '';
  }).join('');
}

async function responseError(response) {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const payload = JSON.parse(text);
      const error = payload?.error;
      detail = typeof error === 'string' ? error : error?.message || '';
    } catch {
      detail = text.slice(0, 300);
    }
  } catch { /* abaikan */ }
  const error = new Error(detail
    ? `HTTP ${response.status}: ${detail}`
    : `HTTP ${response.status}. Periksa Worker, Base URL, API key, model, dan kuota.`);
  error.status = response.status;
  return error;
}

export function createSseParser(onDelta = () => {}) {
  let buffer = '';
  let content = '';
  let model = '';
  let sawEvent = false;

  function dispatch(rawEvent) {
    const dataLines = rawEvent.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart());
    if (!dataLines.length) return;
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    sawEvent = true;
    if (payload?.error) {
      const detail = typeof payload.error === 'string'
        ? payload.error
        : payload.error.message || JSON.stringify(payload.error);
      throw new Error(`Provider error: ${detail}`);
    }
    if (typeof payload?.model === 'string') model = payload.model;
    const choice = payload?.choices?.[0] || {};
    const delta = textFromContent(choice.delta?.content ?? choice.message?.content ?? choice.text ?? '');
    if (delta) {
      content += delta;
      onDelta(delta, content);
    }
  }

  return {
    push(chunk) {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const match = /\r?\n\r?\n/.exec(buffer.slice(boundary, boundary + 4));
        const separatorLength = match ? match[0].length : 2;
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separatorLength);
        dispatch(event);
      }
    },
    finish() {
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
      return { content, model, sawEvent };
    },
    get content() { return content; },
    get model() { return model; },
    get sawEvent() { return sawEvent; }
  };
}

export async function readChatResponse(response, onDelta = () => {}) {
  if (!response.ok) throw await responseError(response);
  const contentType = response.headers.get('Content-Type') || '';
  if (!response.body || !contentType.includes('text/event-stream')) {
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // Beberapa provider mengirim SSE tanpa header yang benar.
      if (text.includes('data:')) {
        const parser = createSseParser(onDelta);
        parser.push(text);
        const result = parser.finish();
        if (result.sawEvent) return result;
      }
      throw new Error('Relay mengembalikan respons yang bukan JSON/SSE.');
    }
    if (payload?.error) {
      const detail = typeof payload.error === 'string'
        ? payload.error
        : payload.error.message || JSON.stringify(payload.error);
      throw new Error(`Provider error: ${detail}`);
    }
    const choice = payload?.choices?.[0] || {};
    const content = textFromContent(choice.message?.content ?? choice.delta?.content ?? choice.text ?? '');
    if (content) onDelta(content, content);
    return { content, model: typeof payload?.model === 'string' ? payload.model : '', sawEvent: false, payload };
  }

  const parser = createSseParser(onDelta);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  const result = parser.finish();
  if (!result.sawEvent && !result.content) {
    throw new Error('Provider mengembalikan stream kosong.');
  }
  return result;
}
