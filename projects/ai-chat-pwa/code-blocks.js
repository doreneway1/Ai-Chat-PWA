const FENCED_CODE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;

export function splitCodeBlocks(content) {
  const parts = [];
  let cursor = 0;
  for (const match of content.matchAll(FENCED_CODE)) {
    const start = match.index + match[0].indexOf('\n') + 1;
    const end = start + match[2].length;
    if (match.index > cursor) {
      parts.push({ type: 'text', value: content.slice(cursor, match.index) });
    }
    parts.push({
      type: 'code',
      language: match[1].trim().split(/\s+/)[0] || 'text',
      value: match[2],
      start,
      end
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length || parts.length === 0) {
    parts.push({ type: 'text', value: content.slice(cursor) });
  }
  return parts;
}

export function replaceCodeBlock(content, block, replacement) {
  if (
    typeof content !== 'string' ||
    !Number.isInteger(block?.start) ||
    !Number.isInteger(block?.end) ||
    block.start < 0 ||
    block.end < block.start ||
    block.end > content.length
  ) {
    throw new Error('Blok kode tidak valid untuk diedit.');
  }
  return content.slice(0, block.start) + replacement + content.slice(block.end);
}
