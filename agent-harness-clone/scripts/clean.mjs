import { rm } from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve(process.cwd(), 'dist');
if (path.dirname(target) !== process.cwd() || path.basename(target) !== 'dist') {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}
await rm(target, { recursive: true, force: true });
