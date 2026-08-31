import type { RuntimeHost } from '../../runtime/runtime-host.js';
import type { ArtifactStore } from '../../artifacts/artifact-store.js';
import type { Tool } from '../tool.js';
import { createBashTool } from './bash.js';
import { createEditFileTool } from './edit-file.js';
import { FileSnapshotStore } from './file-snapshots.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createPowerShellTool, isPowerShellAvailable } from './powershell.js';
import { createReadFileTool } from './read-file.js';
import { createTodoWriteTool, TodoStore } from './todo-write.js';
import { createWriteFileTool } from './write-file.js';
import { createCodeArtifactTool } from './create-code-artifact.js';
import { createContextArtifactReadTool } from './context-artifact-read.js';
import { createCsvArtifactTool } from './create-csv-artifact.js';
import { createDocumentArtifactTool } from './create-document-artifact.js';
import { createHtmlArtifactTool } from './create-html-artifact.js';
import { createJsonArtifactTool } from './create-json-artifact.js';
import { createMarkdownArtifactTool } from './create-markdown-artifact.js';
import { createSpreadsheetArtifactTool } from './create-spreadsheet-artifact.js';

export type BuiltinToolOptions = {
  maxReadBytes?: number;
  /**
   * Include the `powershell` tool. Defaults to `isPowerShellAvailable()`, which
   * is true on win32 or when `AGENT_HARNESS_ENABLE_PWSH=1`. Mirrors the
   * `isPowerShellToolEnabled()` gate in claude-code's `getAllBaseTools`.
   */
  powershell?: boolean;
  /** Include the `todo_write` tool. Defaults to true. */
  todos?: boolean;
  /** Store backing `todo_write`. Pass one in to render the list in a UI. */
  todoStore?: TodoStore;
  /** Auto-approve shell commands classified as read-only. Defaults to true. */
  autoApproveReadOnlyCommands?: boolean;
  /**
   * Response artifact store. When supplied, offers the format-specific artifact
   * tools and a same-session Context Intelligence offload recall tool.
   */
  artifactStore?: ArtifactStore;
  /** Maximum stored artifact size accepted by context_artifact_read. Defaults to 10 MB. */
  maxArtifactReadBytes?: number;
};

export function createBuiltinTools(runtime: RuntimeHost, options: BuiltinToolOptions = {}): Tool[] {
  const snapshots = new FileSnapshotStore();
  const shellOptions =
    options.autoApproveReadOnlyCommands === undefined
      ? {}
      : { autoApproveReadOnly: options.autoApproveReadOnlyCommands };

  return [
    createReadFileTool(runtime, snapshots, options.maxReadBytes),
    createGlobTool(runtime),
    createGrepTool(runtime),
    createWriteFileTool(runtime, snapshots),
    createEditFileTool(runtime, snapshots),
    ...(options.artifactStore
      ? [
          createContextArtifactReadTool(
            options.artifactStore,
            options.maxArtifactReadBytes,
          ),
          createMarkdownArtifactTool(options.artifactStore),
          createHtmlArtifactTool(options.artifactStore),
          createDocumentArtifactTool(options.artifactStore),
          createSpreadsheetArtifactTool(options.artifactStore),
          createCsvArtifactTool(options.artifactStore),
          createJsonArtifactTool(options.artifactStore),
          createCodeArtifactTool(options.artifactStore),
        ]
      : []),
    createBashTool(runtime, shellOptions),
    ...((options.powershell ?? isPowerShellAvailable())
      ? [createPowerShellTool(runtime, shellOptions)]
      : []),
    ...((options.todos ?? true) ? [createTodoWriteTool(options.todoStore ?? new TodoStore())] : []),
  ];
}

export { createBashTool } from './bash.js';
export type { BashToolOptions } from './bash.js';
export { createEditFileTool } from './edit-file.js';
export { FileSnapshotStore } from './file-snapshots.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createPowerShellTool, isPowerShellAvailable } from './powershell.js';
export type { PowerShellToolOptions } from './powershell.js';
export { createReadFileTool } from './read-file.js';
export { createTodoWriteTool, formatTodos, TodoStore } from './todo-write.js';
export type { TodoItem, TodoStatus } from './todo-write.js';
export { createWriteFileTool } from './write-file.js';
export { createContextArtifactReadTool } from './context-artifact-read.js';
export { createMarkdownArtifactTool } from './create-markdown-artifact.js';
export { createHtmlArtifactTool } from './create-html-artifact.js';
export { createDocumentArtifactTool } from './create-document-artifact.js';
export { createSpreadsheetArtifactTool } from './create-spreadsheet-artifact.js';
export { createCsvArtifactTool } from './create-csv-artifact.js';
export { createJsonArtifactTool } from './create-json-artifact.js';
export { createCodeArtifactTool } from './create-code-artifact.js';
