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
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_FORMATS;

export function artifactFilename(value: string, kind: ArtifactKind): string {
  const format = ARTIFACT_FORMATS[kind];
  const leaf =
    value.replaceAll('\\', '/').split('/').at(-1)?.trim() || `document${format.extension}`;
  const safe = leaf
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 196);
  const base = safe && safe !== '.' && safe !== '..' ? safe : 'document';
  return base.toLowerCase().endsWith(format.extension) ? base : `${base}${format.extension}`;
}

export function artifactKindFromContentType(value: string): ArtifactKind | undefined {
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
  return (
    Object.entries(ARTIFACT_FORMATS) as Array<
      [ArtifactKind, (typeof ARTIFACT_FORMATS)[ArtifactKind]]
    >
  ).find(([, format]) => format.contentType.split(';', 1)[0] === mediaType)?.[0];
}

/** Format-neutral durable key. Filename is metadata, not object identity. */
export function artifactContentKey(id: string): string {
  return `${id}/content`;
}
