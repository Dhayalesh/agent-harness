export type RuntimeFileStat = {
  size: number;
  modifiedAtMs: number;
  isFile: boolean;
  isDirectory: boolean;
};

export type RuntimeDirectoryEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

export type RuntimeExecOptions = {
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal: AbortSignal;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
};

export type RuntimeExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
};

export interface RuntimeHost {
  readonly kind: string;
  readonly rootDirectory: string;
  resolvePath(path: string, allowMissing?: boolean): Promise<string>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  stat(path: string): Promise<RuntimeFileStat>;
  readDirectory(path: string): Promise<RuntimeDirectoryEntry[]>;
  execute(command: string, options: RuntimeExecOptions): Promise<RuntimeExecResult>;
}
