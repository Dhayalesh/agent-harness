export type FileSnapshot = {
  content: string;
  modifiedAtMs: number;
};

export class FileSnapshotStore {
  private readonly snapshots = new Map<string, FileSnapshot>();

  set(path: string, snapshot: FileSnapshot): void {
    this.snapshots.set(path, snapshot);
  }

  get(path: string): FileSnapshot | undefined {
    return this.snapshots.get(path);
  }

  delete(path: string): void {
    this.snapshots.delete(path);
  }
}
