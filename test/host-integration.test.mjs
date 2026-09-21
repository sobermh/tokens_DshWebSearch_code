import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const outerRoot = process.env.TOKENS_OUTER_ROOT
  ? path.resolve(process.env.TOKENS_OUTER_ROOT)
  : undefined;
const vitest = outerRoot ? path.join(outerRoot, "desktop", "deepseek-harness", "node_modules", "vitest", "vitest.mjs") : "";
const spec = fileURLToPath(new URL("host-runtime.spec.ts", import.meta.url));
const config = fileURLToPath(new URL("host-vitest.config.mjs", import.meta.url));
const hostNode = process.env.TOKENS_HOST_NODE
  ? path.resolve(process.env.TOKENS_HOST_NODE)
  : process.execPath;

test("real host tool-web executes this plugin provider end to end", {
  skip: !outerRoot || !existsSync(vitest)
    ? "set TOKENS_OUTER_ROOT to a prepared TokensHarness checkout"
    : false,
}, () => {
  const harnessRoot = path.join(outerRoot, "desktop", "deepseek-harness");
  const result = spawnSync(hostNode, [
    vitest,
    "run",
    spec,
    "--config",
    config,
    "--reporter=dot",
  ], {
    cwd: harnessRoot,
    env: { ...process.env, TOKENS_OUTER_ROOT: outerRoot },
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
