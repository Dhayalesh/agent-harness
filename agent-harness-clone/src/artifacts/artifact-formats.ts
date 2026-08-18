export const ARTIFACT_FORMATS = {
  markdown: {
    extension: '.md',
    contentType: 'text/markdown; charset=utf-8',
    label: 'Markdown',
  },
  html: {
    extension: '.html',
    contentType: 'text/html; charset=utf-8',
    label: 'HTML',
  },
  docx: {
    extension: '.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
  },
  xlsx: {
    extension: '.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel workbook',
  },
  csv: {
    extension: '.csv',
    contentType: 'text/csv; charset=utf-8',
    label: 'CSV',
  },
  json: {
    extension: '.json',
    contentType: 'application/json; charset=utf-8',
    label: 'JSON',
  },
  ndjson: {
    extension: '.ndjson',
    contentType: 'application/x-ndjson; charset=utf-8',
    label: 'NDJSON',
  },
  /**
   * Source code, in any of `CODE_LANGUAGES`.
   *
   * The only kind whose extension is not fixed: the language decides it, so the
   * `extension` here is the fallback used when no language was named. The content
   * type stays `text/plain` for every language on purpose — these bytes are served
   * back to a browser, and a precise type such as `text/html` or `image/svg+xml`
   * would invite the very rendering a code file must never get.
   */
  code: {
    extension: '.txt',
    contentType: 'text/plain; charset=utf-8',
    label: 'Source code',
  },
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_FORMATS;

/**
 * The languages `create_code_artifact` can label a file with.
 *
 * Extension only. Highlighting is the reader's business, and the download name is
 * the one thing the file itself has to carry.
 */
export const CODE_LANGUAGES = {
  bash: { extension: '.sh', label: 'Bash' },
  c: { extension: '.c', label: 'C' },
  cpp: { extension: '.cpp', label: 'C++' },
  csharp: { extension: '.cs', label: 'C#' },
  css: { extension: '.css', label: 'CSS' },
  dart: { extension: '.dart', label: 'Dart' },
  dockerfile: { extension: '.dockerfile', label: 'Dockerfile' },
  go: { extension: '.go', label: 'Go' },
  graphql: { extension: '.graphql', label: 'GraphQL' },
  groovy: { extension: '.groovy', label: 'Groovy' },
  ini: { extension: '.ini', label: 'INI' },
  java: { extension: '.java', label: 'Java' },
  javascript: { extension: '.js', label: 'JavaScript' },
  jsx: { extension: '.jsx', label: 'JavaScript (JSX)' },
  kotlin: { extension: '.kt', label: 'Kotlin' },
  lua: { extension: '.lua', label: 'Lua' },
  makefile: { extension: '.mk', label: 'Makefile' },
  objectivec: { extension: '.m', label: 'Objective-C' },
  perl: { extension: '.pl', label: 'Perl' },
  php: { extension: '.php', label: 'PHP' },
  powershell: { extension: '.ps1', label: 'PowerShell' },
  python: { extension: '.py', label: 'Python' },
  r: { extension: '.r', label: 'R' },
  ruby: { extension: '.rb', label: 'Ruby' },
  rust: { extension: '.rs', label: 'Rust' },
  scala: { extension: '.scala', label: 'Scala' },
  sql: { extension: '.sql', label: 'SQL' },
  swift: { extension: '.swift', label: 'Swift' },
  terraform: { extension: '.tf', label: 'Terraform' },
  toml: { extension: '.toml', label: 'TOML' },
  tsx: { extension: '.tsx', label: 'TypeScript (TSX)' },
  typescript: { extension: '.ts', label: 'TypeScript' },
  xml: { extension: '.xml', label: 'XML' },
  yaml: { extension: '.yaml', label: 'YAML' },
  text: { extension: '.txt', label: 'Plain text' },
} as const;

export type CodeLanguage = keyof typeof CODE_LANGUAGES;

export const CODE_LANGUAGE_NAMES = Object.keys(CODE_LANGUAGES) as [CodeLanguage, ...CodeLanguage[]];

export type ArtifactFormatOptions = {
  /** Only read for the `code` kind, where it selects the extension. */
  language?: CodeLanguage;
};

/** The extension a kind's downloads carry, resolving `code` through its language. */
export function artifactExtension(kind: ArtifactKind, options: ArtifactFormatOptions = {}): string {
  if (kind === 'code' && options.language) return CODE_LANGUAGES[options.language].extension;
  return ARTIFACT_FORMATS[kind].extension;
}

export function artifactFilename(
  value: string,
  kind: ArtifactKind,
  options: ArtifactFormatOptions = {},
): string {
  const extension = artifactExtension(kind, options);
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.trim() || `document${extension}`;
  const safe = leaf
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 196);
  const base = safe && safe !== '.' && safe !== '..' ? safe : 'document';
  return base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
}

/**
 * `code` is deliberately absent from this reverse lookup: every language shares
 * `text/plain`, so a content type cannot identify one. Callers that need the kind
 * of a code artifact read `metadata.kind`, which the generating tool always sets.
 */
export function artifactKindFromContentType(value: string): ArtifactKind | undefined {
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return (
    Object.entries(ARTIFACT_FORMATS) as Array<
      [ArtifactKind, (typeof ARTIFACT_FORMATS)[ArtifactKind]]
    >
  ).find(
    ([kind, format]) => kind !== 'code' && format.contentType.split(';', 1)[0] === mediaType,
  )?.[0];
}

/** The language whose extension matches a filename, for labelling a code artifact. */
export function codeLanguageFromFilename(value: string): CodeLanguage | undefined {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1)?.trim().toLowerCase() ?? '';
  let match: CodeLanguage | undefined;
  for (const [language, format] of Object.entries(CODE_LANGUAGES) as Array<
    [CodeLanguage, (typeof CODE_LANGUAGES)[CodeLanguage]]
  >) {
    // Longest extension wins, so `.tsx` is not read as `.ts` with a stray x.
    if (!leaf.endsWith(format.extension)) continue;
    if (!match || format.extension.length > CODE_LANGUAGES[match].extension.length) {
      match = language;
    }
  }
  return match;
}

/** Format-neutral durable key. Filename is metadata, not object identity. */
export function artifactContentKey(id: string): string {
  return `${id}/content`;
}
