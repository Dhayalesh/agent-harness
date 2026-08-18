import type { ArtifactFormatOptions, ArtifactKind } from '../../artifacts/artifact-formats.js';
import { ARTIFACT_FORMATS, artifactFilename } from '../../artifacts/artifact-formats.js';
import type { ToolExecutionContext } from '../tool.js';

export function artifactDescriptor(
  kind: ArtifactKind,
  title: string,
  requestedFilename: string,
  context: ToolExecutionContext,
  options: ArtifactFormatOptions = {},
): { filename: string; contentType: string; metadata: Record<string, unknown> } {
  const filename = artifactFilename(requestedFilename, kind, options);
  return {
    filename,
    contentType: ARTIFACT_FORMATS[kind].contentType,
    metadata: {
      kind,
      title: cleanTitle(title),
      filename,
      presentation: 'file',
      // Present only for `code`, where the content type cannot carry the language.
      ...(options.language ? { language: options.language } : {}),
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    },
  };
}

function cleanTitle(value: string): string {
  return (
    value
      .replace(/[\x00-\x1F\x7F]/g, ' ')
      .trim()
      .slice(0, 200) || 'Document'
  );
}
