// Jendela konteks untuk request chat: pemotongan riwayat, ringkasan, lampiran
// gambar, dan blok konteks tautan/pencarian. Diekstrak dari app.js agar
// dapat diuji tanpa DOM.

import { buildLinkContextBlock } from './link-context.js';
import { buildSearchContextBlock } from './web-search.js';

export function buildApiMessages(conversation, {
  systemMessage,
  maxMessages = 38,
  maxBytes = 7_500_000
} = {}) {
  const filtered = conversation.messages.filter(message => !message.error);
  const summaryThrough = conversation.summary
    ? Math.min(Number.isInteger(conversation.summaryThrough) ? conversation.summaryThrough : 0, filtered.length)
    : 0;
  const history = filtered.slice(summaryThrough).slice(-maxMessages);
  let lastUserIndex = -1;
  history.forEach((message, index) => {
    if (message.role === 'user') lastUserIndex = index;
  });
  const messages = history.map((message, index) => {
    let content = message.content;
    if (Array.isArray(content) && index !== lastUserIndex) {
      content = content.filter(part => part.type === 'text');
    }
    if (index === lastUserIndex && (
      (Array.isArray(message.linkSources) && message.linkSources.length) ||
      (Array.isArray(message.webSources) && message.webSources.length)
    )) {
      // Konteks tautan/pencarian hanya dikirim untuk pesan user terakhir, sama
      // seperti lampiran gambar, agar riwayat lama tidak menghabiskan konteks.
      const linkSources = Array.isArray(message.linkSources) ? message.linkSources : [];
      const webSources = Array.isArray(message.webSources) ? message.webSources : [];
      const block = buildLinkContextBlock(linkSources);
      const searchBlock = buildSearchContextBlock(webSources);
      const failures = [...linkSources, ...webSources]
        .filter(source => source.status === 'error')
        .map(source => `Sumber gagal dibaca: ${source.url} (${source.error || 'tidak diketahui'})`);
      const extra = [block, searchBlock, ...failures].filter(Boolean).join('\n\n');
      if (extra) {
        if (typeof content === 'string') {
          content = `${content}\n\n${extra}`;
        } else if (Array.isArray(content)) {
          // Gabungkan blok konteks ke bagian teks pertama bila muat, agar
          // jumlah parts tidak bertambah (batas Worker 12 parts). Bila tidak
          // muat, tambahkan sebagai part terpisah seperti sebelumnya.
          const merged = content.map(part => (part.type === 'text' ? { ...part } : part));
          const firstText = merged.find(part => part.type === 'text');
          if (firstText && firstText.text.length + extra.length + 2 <= 99_000) {
            firstText.text = `${firstText.text}\n\n${extra}`;
          } else {
            merged.push({ type: 'text', text: extra });
          }
          content = merged;
        }
      }
    }
    return { role: message.role, content };
  });
  const encoder = new TextEncoder();
  let usedBytes = encoder.encode(JSON.stringify(systemMessage)).byteLength;
  const recentMessages = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageBytes = encoder.encode(JSON.stringify(messages[index])).byteLength + 1;
    if (usedBytes + messageBytes > maxBytes) break;
    usedBytes += messageBytes;
    recentMessages.push(messages[index]);
  }
  return [systemMessage, ...recentMessages.reverse()];
}
