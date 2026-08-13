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
import { createMarkdownArtifactTool } from './create-markdown-artifact.js';

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
   * Response artifact store. When supplied, offers `create_markdown_artifact` so
   * the model can choose file presentation for document requests.
   */
  artifactStore?: ArtifactStore;
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
    ...(options.artifactStore ? [createMarkdownArtifactTool(options.artifactStore)] : []),
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
export { createMarkdownArtifactTool } from './create-markdown-artifact.js';
