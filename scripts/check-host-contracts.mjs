#!/usr/bin/env node
/**
 * `npm run check:host` — the real-host contract check the product gate runs.
 *
 * The gate passes exactly one environment variable:
 *
 *   DSH_HOST_ROOT   the staged host's dsh-plugin-desktop directory, e.g.
 *                   C:\…\TokensCowork\.build\desktop\dsh-plugin-desktop
 *
 * It is mapped here onto this repository's own variable, so the gate never has
 * to know the name: TOKENS_HOST_ROOT = DSH_HOST_ROOT, the staged runtime that
 * HOST-005…022 run on.
 *
 * HOST-001…004 are the older source-mode cases. They do not run on a staged
 * host at all: they compile the Harness from the outer product checkout, which
 * needs that checkout's own node_modules to be installed and current (the main
 * checkout's is routinely stale and fails on a missing third-party package that
 * has nothing to do with this plugin). Deriving it would make the gate red for
 * someone else's reason, so it is opt-in with --outer-root / TOKENS_OUTER_ROOT
 * and otherwise reported as not executed, pointing at the staged-host cases
 * that reach the same host interfaces.
 *
 * Without DSH_HOST_ROOT every case is reported NOT EXECUTED and the exit code is
 * non-zero: the gate must never read "nothing ran" as "nothing is wrong".
 *
 * Local extra: DSH_HOST_ROOTS takes a `;`-separated list and runs the whole set
 * one host at a time (one process at a time, so a low-memory machine survives).
 * The gate does not pass it.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(repoRoot, "test", "run-test-cases.mjs");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`NOT EXECUTED\tCHECK-HOST\t${flag} requires a path`);
    process.exit(1);
  }
  return value;
}

const listed = argValue("--host-root") ?? process.env.DSH_HOST_ROOT ?? process.env.DSH_HOST_ROOTS;
const hostRoots = (listed ?? "")
  .split(";")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));

const outerRoot = argValue("--outer-root") ?? process.env.TOKENS_OUTER_ROOT;

function runOne(hostRoot) {
  const env = { ...process.env, TOKENS_HOST_ROOT: hostRoot };
  delete env.TOKENS_OUTER_ROOT;
  if (outerRoot !== undefined) env.TOKENS_OUTER_ROOT = path.resolve(outerRoot);
  if (hostRoot === undefined) delete env.TOKENS_HOST_ROOT;
  const result = spawnSync(process.execPath, [runner, "--host-contracts"], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`NOT EXECUTED\tCHECK-HOST\t${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (hostRoots.length === 0) {
  console.error("DSH_HOST_ROOT is not set; it must point at a staged host's dsh-plugin-desktop directory.");
  // Still run, so the output lists every case that did not execute by name
  // rather than only saying the variable is missing. The exit code is 1 either
  // way: an unexecuted contract check is a failed contract check.
  runOne(undefined);
  process.exit(1);
}

let failed = 0;
for (const hostRoot of hostRoots) {
  if (!existsSync(path.join(hostRoot, "node_modules", "@deepseek-ai", "dsh", "package.json"))) {
    console.error(`NOT EXECUTED\tCHECK-HOST\tnot a staged host (no node_modules/@deepseek-ai/dsh): ${hostRoot}`);
    failed += 1;
    continue;
  }
  if (runOne(hostRoot) !== 0) failed += 1;
}
if (hostRoots.length > 1) {
  console.log(`${hostRoots.length - failed}/${hostRoots.length} staged hosts passed the contract check.`);
}
process.exit(failed > 0 ? 1 : 0);
