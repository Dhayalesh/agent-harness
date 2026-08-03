#!/usr/bin/env node
/**
 * Uploads one `SKILL.md` to S3, at the address a `skills` record names.
 *
 *   npx tsx --env-file=.env scripts/content/uploadSkill.ts --file skills/abap-review.md --uri s3://your-bucket/skills/abap-review.md
 *
 * Optional. Nothing requires the platform to write the object: author the Markdown and
 * put it in S3 with the console or aws-cli if you prefer. This exists so the round trip
 * can be done with the credential already in `.env` and, more usefully, so the document
 * is read back and parsed through the same code a run uses — which proves the address in
 * the record is one that resolves.
 *
 * TypeScript, unlike its siblings in `scripts/skill`, because signing an S3 request
 * means reusing `src/content/s3-content-store.ts` rather than restating SigV4: one
 * signing implementation is the point.
 */
import { readFile } from 'node:fs/promises';
import { errorMessage } from '../../src/core/errors.js';
import { parseS3Uri } from '../../src/content/s3-uri.js';
import { SkillContentStores } from '../../src/platform/skill-content.js';
import { parseSkill } from '../../src/skills/skills.js';

const { file, uri } = parseArguments(process.argv.slice(2));
if (!file || !uri) {
  process.stderr.write(
    'usage: npx tsx --env-file=.env scripts/content/uploadSkill.ts --file <path.md> ' +
      '--uri s3://bucket/key.md\n',
  );
  process.exit(2);
}

try {
  const text = await readFile(file, 'utf8');
  if (text.trim() === '') throw new Error(`${file} is empty: there is no skill to store`);

  const { location, store } = new SkillContentStores().locate(uri, file);
  const written = await store.write(location.key, text);
  // Read back through the path a run takes, so the address is proven rather than
  // assumed, and parsed so a document a run could not use is reported now.
  const { text: stored } = await store.load(written.key);
  const parsed = parseSkill(stored, 'placeholder/SKILL.md');

  process.stdout.write(
    `uploaded ${file} -> ${uri} (${written.bytes} bytes)\n` +
      `  description: ${parsed.description}\n` +
      `  allowedTools: ${parsed.allowedTools?.join(', ') ?? 'none'}\n\n` +
      'register it with node scripts/skill/seedSkill.js:\n\n' +
      `  { name: '<handle>', uri: '${uri}' }\n`,
  );
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}

function parseArguments(argv: readonly string[]): { file?: string; uri?: string } {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    flags.set(argument.slice(2), value);
    index += 1;
  }
  const file = flags.get('file');
  const uri = flags.get('uri');
  return {
    ...(file === undefined ? {} : { file }),
    ...(uri === undefined ? {} : { uri }),
  };
}
