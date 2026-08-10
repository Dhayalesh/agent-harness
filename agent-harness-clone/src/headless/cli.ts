#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentHarnessError } from '../core/errors.js';
import { invokeHeadless, streamHeadless } from './invoke.js';

/**
 * Runs a payload file. `agent-harness-headless payload.json [--stream] [--events]`.
 *
 * The point of this entrypoint is that the file is the whole configuration: the same
 * JSON a caller would POST runs here unchanged, so a payload can be developed and
 * debugged locally and then sent to a deployment without translation. No database
 * connection is opened; AWS configuration is consulted only when a skill URI is read.
 *
 * `--stream` prints events as JSON lines as they happen, which is what to use for a
 * long run. Without it the result is printed once, as a single object.
 */

const positional: string[] = [];
let streaming = false;
let events = false;
let promptOverride: string | undefined;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index] as string;
  if (argument === '--stream') {
    streaming = true;
  } else if (argument === '--events') {
    events = true;
  } else if (argument === '--prompt') {
    index += 1;
    promptOverride = process.argv[index];
  } else if (argument === '--help' || argument === '-h') {
    process.stdout.write(usage());
    process.exit(0);
  } else {
    positional.push(argument);
  }
}

const file = positional[0];
if (!file) {
  process.stderr.write(usage());
  process.exit(2);
}

const payload = await readPayload(path.resolve(file));
if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
  // Both flags are overlays on the file rather than separate options, so the file
  // stays the single description of the run. `--prompt` lets one payload be reused
  // across prompts, which is the common loop when iterating on a system prompt.
  Object.assign(payload as Record<string, unknown>, {
    ...(promptOverride === undefined ? {} : { prompt: promptOverride }),
    ...(events ? { includeEvents: true } : {}),
  });
}

const runOptions = {
  logger: (message: string) => process.stderr.write(`${message}\n`),
};

try {
  if (streaming) {
    for await (const event of streamHeadless(payload, runOptions)) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
  } else {
    const result = await invokeHeadless(payload, runOptions);
    process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`);
    if (result.status === 'error') process.exitCode = 1;
  }
} catch (error) {
  // A payload this runner could not act on. Printed as a message rather than a stack,
  // because the useful part is which field the schema or the registry objected to.
  process.stderr.write(`${describe(error)}\n`);
  process.exitCode = 1;
}

async function readPayload(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    process.stderr.write(`Cannot read payload file: ${file}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    process.stderr.write(`${file} is not valid JSON: ${describe(error)}\n`);
    process.exit(2);
  }
}

function describe(error: unknown): string {
  if (error instanceof AgentHarnessError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return [
    'Usage: agent-harness-headless <payload.json> [options]',
    '',
    'Options:',
    '  --stream           print events as JSON lines instead of one result',
    '  --events           include the event log in the printed result',
    '  --prompt <text>    override the payload prompt',
    '  -h, --help         show this message',
    '',
  ].join('\n');
}
