/**
 * Dependency-free HTML to readable-text conversion for the web_fetch tool.
 *
 * This is deliberately not a full Markdown converter. It keeps document
 * structure the model needs (headings, list items, links, code, paragraph
 * breaks) and discards everything that only matters for rendering.
 */

const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'head',
];

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  prime: '′',
  Prime: '″',
  larr: '←',
  rarr: '→',
  harr: '↔',
  darr: '↓',
  uarr: '↑',
};

/** Decode the HTML entities that appear in real documents. */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/** Extract the document title, when present. */
export function extractHtmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return undefined;
  const title = collapseInlineWhitespace(decodeHtmlEntities(stripTags(match[1])));
  return title.length ? title : undefined;
}

/**
 * Convert an HTML document to readable text with light Markdown structure.
 *
 * @param html raw HTML source
 * @param baseUrl used to absolutize link targets; links are dropped when it is
 *   absent and the target is relative
 */
export function htmlToReadableText(html: string, baseUrl?: string): string {
  let working = stripComments(html);
  for (const element of DROPPED_ELEMENTS) {
    working = working.replace(
      new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}\\s*>`, 'gi'),
      ' ',
    );
    // Unclosed dropped element: discard to the end rather than leaking source.
    working = working.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
  }

  working = working.replace(/<br\s*\/?>/gi, '\n');
  working = working.replace(/<\/(?:p|div|section|article|header|footer|main|aside)\s*>/gi, '\n\n');
  working = working.replace(/<\/(?:tr|table|ul|ol|dl|blockquote|pre|figure)\s*>/gi, '\n\n');
  working = working.replace(/<(?:td|th)\b[^>]*>/gi, ' | ');
  working = working.replace(/<li\b[^>]*>/gi, '\n- ');
  working = working.replace(/<\/li\s*>/gi, '\n');
  working = working.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
  working = working.replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => {
    return `\n\n${'#'.repeat(Number(level))} `;
  });
  working = working.replace(/<\/h[1-6]\s*>/gi, '\n\n');
  working = working.replace(/<code\b[^>]*>/gi, '`').replace(/<\/code\s*>/gi, '`');
  working = working.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attributes, label) => {
    const text = collapseInlineWhitespace(decodeHtmlEntities(stripTags(String(label))));
    if (!text) return ' ';
    const href = resolveHref(attributeValue(String(attributes), 'href'), baseUrl);
    return href ? `[${text}](${href})` : text;
  });
  working = working.replace(/<img\b([^>]*)>/gi, (_match, attributes) => {
    const alt = collapseInlineWhitespace(
      decodeHtmlEntities(attributeValue(String(attributes), 'alt') ?? ''),
    );
    return alt ? `[image: ${alt}]` : ' ';
  });

  const text = decodeHtmlEntities(stripTags(working));
  return normalizeBlankLines(text);
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function attributeValue(attributes: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attributes);
  if (quoted) return quoted[2] ?? quoted[3];
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(attributes);
  return bare?.[1];
}

function resolveHref(href: string | undefined, baseUrl: string | undefined): string | undefined {
  if (!href) return undefined;
  const decoded = decodeHtmlEntities(href).trim();
  if (!decoded || decoded.startsWith('#')) return undefined;
  try {
    const resolved = baseUrl ? new URL(decoded, baseUrl) : new URL(decoded);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

function collapseInlineWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeBlankLines(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
