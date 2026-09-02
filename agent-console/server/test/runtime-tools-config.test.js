import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const configUrl = new URL("../src/config.js", import.meta.url).href;

async function configuredTools(value) {
  const env = { ...process.env };
  if (value === undefined) delete env.AGENT_RUNTIME_TOOLS;
  else env.AGENT_RUNTIME_TOOLS = value;
  const source =
    `import { AVAILABLE_TOOLS } from ${JSON.stringify(configUrl)};` +
    "process.stdout.write(JSON.stringify(AVAILABLE_TOOLS));";
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { env },
  );
  return JSON.parse(stdout);
}

test("web_search is configurable but absent from the default runtime catalogue", async () => {
  const defaults = await configuredTools(undefined);
  const configured = await configuredTools("read_file,web_search");

  assert.equal(defaults.includes("web_search"), false);
  assert.deepEqual(configured, ["read_file", "web_search"]);
});
