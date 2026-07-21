export type VersionInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
};

export interface VersionSource {
  latest(packageName: string): Promise<string>;
}

export async function checkForUpdate(
  packageName: string,
  current: string,
  source: VersionSource,
): Promise<VersionInfo> {
  const latest = await source.latest(packageName);
  return { current, latest, updateAvailable: compareVersions(latest, current) > 0 };
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/, '').split('.').map(Number);
  const rightParts = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
