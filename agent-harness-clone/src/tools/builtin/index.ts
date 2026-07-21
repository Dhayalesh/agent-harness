import type { RuntimeHost } from '../../runtime/runtime-host.js';
import type { Tool } from '../tool.js';
import { createBashTool } from './bash.js';
import { createEditFileTool } from './edit-file.js';
import { FileSnapshotStore } from './file-snapshots.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createReadFileTool } from './read-file.js';
import { createWriteFileTool } from './write-file.js';

export type BuiltinToolOptions = {
  maxReadBytes?: number;
};

export function createBuiltinTools(runtime: RuntimeHost, options: BuiltinToolOptions = {}): Tool[] {
  const snapshots = new FileSnapshotStore();
  return [
    createReadFileTool(runtime, snapshots, options.maxReadBytes),
    createGlobTool(runtime),
    createGrepTool(runtime),
    createWriteFileTool(runtime, snapshots),
    createEditFileTool(runtime, snapshots),
    createBashTool(runtime),
  ];
}

export { createBashTool } from './bash.js';
export { createEditFileTool } from './edit-file.js';
export { FileSnapshotStore } from './file-snapshots.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createReadFileTool } from './read-file.js';
export { createWriteFileTool } from './write-file.js';
