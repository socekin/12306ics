const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/**
 * Convert an HTML email body to plain text, one block element per line.
 * Inline tags are dropped so that a ticket line inside <div> stays on one line.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|tbody|thead|section|article|blockquote|header|footer)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t 　]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
