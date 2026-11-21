export const DEFAULT_GENERATION_SETTINGS = Object.freeze({
  temperature: 0.7,
  maxTokens: 4096,
  webSearch: false,
  autoSummary: true
});

export function normalizeGenerationSettings(value = {}) {
  const temperature = Number(value?.temperature);
  const maxTokens = Number(value?.maxTokens);
  return {
    temperature: Number.isFinite(temperature)
      ? Math.min(2, Math.max(0, temperature))
      : DEFAULT_GENERATION_SETTINGS.temperature,
    maxTokens: Number.isInteger(maxTokens)
      ? Math.min(16_384, Math.max(256, maxTokens))
      : DEFAULT_GENERATION_SETTINGS.maxTokens,
    webSearch: Boolean(value?.webSearch),
    autoSummary: value?.autoSummary !== false
  };
}

export function cleanGeneratedTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^```(?:\w+)?|```$/g, '')
    .replace(/^["'“”‘’#\-\s]+|["'“”‘’\s.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function estimateMessageTokens(messages) {
  const text = (Array.isArray(messages) ? messages : []).map(message => {
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content)) {
      return message.content.map(part => part?.type === 'text' ? part.text || '' : '[gambar]').join('\n');
    }
    return '';
  }).join('\n');
  const chars = text.length;
  // Estimasi kasar multibahasa: ±4 karakter per token. Ini indikator UI,
  // bukan janji jumlah token yang ditagih provider.
  return { chars, tokens: Math.ceil(chars / 4) };
}

export function shouldSummarizeConversation(conversation) {
  const messages = (conversation?.messages || []).filter(message => !message.error);
  const summaryThrough = Number.isInteger(conversation?.summaryThrough) ? conversation.summaryThrough : 0;
  const unsummarized = messages.slice(summaryThrough, -16);
  if (messages.length < 34 || unsummarized.length < 18) return false;
  const { chars } = estimateMessageTokens(unsummarized);
  return chars >= 12_000 || unsummarized.length >= 24;
}

export function buildSummarySource(conversation) {
  const messages = (conversation?.messages || []).filter(message => !message.error);
  const summaryThrough = Number.isInteger(conversation?.summaryThrough) ? conversation.summaryThrough : 0;
  const batch = messages.slice(summaryThrough, -16);
  const transcript = batch.map(message => {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        : '';
    return `${message.role === 'user' ? 'Pengguna' : 'Asisten'}: ${content.slice(0, 6000)}`;
  }).join('\n\n').slice(0, 60_000);
  return { batchCount: batch.length, transcript, nextThrough: summaryThrough + batch.length };
}
