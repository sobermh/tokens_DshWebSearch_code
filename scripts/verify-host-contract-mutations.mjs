#!/usr/bin/env node
/**
 * Prove the real-host contract cases are not idle.
 *
 * A contract case that cannot fail is worse than no case: it reports green
 * forever while the thing it claims to protect rots. This script breaks one
 * path at a time in the plugin (or its manifest), runs `--host-contracts`, and
 * checks that EXACTLY the cases which depend on that path went red. Too few
 * failures means the case is idle; too many means it is over-specified and will
 * cost an afternoon at every upstream upgrade.
 *
 * Usage:  node scripts/verify-host-contract-mutations.mjs            (all)
 *         node scripts/verify-host-contract-mutations.mjs M07 M12    (a subset)
 *
 * Needs DSH_HOST_ROOT, exactly like `npm run check:host`. Run it on a DSH 0.2
 * host for the 0.2 mutations and on a 0.1 host for M14; each mutation says
 * which host lines it applies to.
 *
 * Every mutation is reverted in a finally block, and the script refuses to
 * start if the work tree it is about to edit is already dirty.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(repoRoot, "test", "run-test-cases.mjs");

/**
 * `line` is the host generation a mutation is meaningful on: "0.2", "0.1", or
 * "any". `expect` is the set of cases that must turn red; by default it must be
 * the complete set, and `allowExtra` relaxes that for the few mutations whose
 * blast radius is the point (a plugin that fails to activate takes every case
 * with it, and a plugin loaded from somewhere else is simply other code).
 * `expectOn` overrides `expect` for one generation, because the two settings
 * cases swap places: HOST-018 only runs on 0.2 and HOST-019 only on 0.1.
 */
const MUTATIONS = [
  {
    id: "M01",
    line: "any",
    what: "the suite loads the host's pinned copy instead of this work tree",
    file: "test/host-contract/live-host.mjs",
    from: 'export const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));',
    to: 'export const pluginRoot = path.join(path.resolve(process.env.TOKENS_HOST_ROOT), "product-plugins", "tokens-dsh-web-search");',
    expect: ["HOST-005"],
    // Loading another version of the plugin naturally breaks other cases too;
    // what matters is that HOST-005 names the cause.
    allowExtra: true,
  },
  {
    id: "M02",
    line: "0.2",
    what: "the plugin takes the DSH 0.1 settings branch on a DSH 0.2 host",
    file: "lib/index.js",
    from: 'const installSettingsSection = typeof dshSettings.installSettingsSection === "function"\n  ? dshSettings.installSettingsSection\n  : undefined;',
    to: 'const installSettingsSection = typeof dshSettings.installSettingsSection === "function"\n  ? dshSettings.installSettingsSection\n  : (ctx, ns, schema, entry, hooks) => { hooks.setSource(() => entry ?? {}); };',
    // The plugin still activates and registers its tools -- it just serves a
    // settings contract this host does not have, so everything that reads a
    // setting breaks while HOST-007 stays green.
    expect: ["HOST-006", "HOST-014", "HOST-015", "HOST-016", "HOST-018", "HOST-020", "HOST-022"],
  },
  {
    id: "M03",
    line: "any",
    what: "the plugin stops declaring the web service it injects",
    file: "lib/index.js",
    from: 'const inject = ["web"];',
    to: 'const inject = [];',
    expect: ["HOST-007"],
    // apply() then runs without ctx.web and throws, so nothing registers at
    // all. HOST-007 is the case that says why.
    allowExtra: true,
  },
  {
    id: "M04",
    line: "any",
    what: "the provider id no longer matches the id the patch configures",
    file: "lib/index.js",
    from: '    id: "ddg",\n    available() {',
    to: '    id: "ddg-renamed",\n    available() {',
    // Only the two cases that go through the seam. Everything else reaches the
    // provider object directly and never asks the host to select it by id.
    expect: ["HOST-008", "HOST-009"],
  },
  {
    id: "M05",
    line: "any",
    what: "a search result loses the url every consumer of the seam reads",
    file: "lib/index.js",
    from: "    sources.push({\n      url: hrefMatch[1],",
    to: "    sources.push({\n      url: undefined,",
    expect: ["HOST-008", "HOST-009", "HOST-011", "HOST-016", "HOST-018"],
    expectOn: { "0.1": ["HOST-008", "HOST-009", "HOST-011", "HOST-016", "HOST-019"] },
  },
  {
    id: "M06",
    line: "any",
    what: "a tool parameter schema leaves the subset the host enforces",
    file: "lib/index.js",
    from: '            platform: {\n              type: "string",',
    to: '            platform: {\n              type: "not-a-json-schema-type",',
    expect: ["HOST-007", "HOST-010", "HOST-012"],
  },
  {
    id: "M07",
    line: "any",
    what: "advanced_search returns a field its own output schema forbids",
    file: "lib/index.js",
    from: "            return {\n              provider: result.provider ?? result._provider ?? \"bing\",",
    to: "            return {\n              unexpected: true,\n              provider: result.provider ?? result._provider ?? \"bing\",",
    expect: ["HOST-011"],
  },
  {
    id: "M08",
    line: "any",
    what: "a disabled platform is silently searched anyway",
    file: "lib/index.js",
    from: "            if (!enabled.includes(platform)) {\n              throw new Error(",
    to: "            if (false && !enabled.includes(platform)) {\n              throw new Error(",
    expect: ["HOST-012"],
  },
  {
    id: "M09",
    line: "any",
    what: "free_search_test reports an unconfigured engine as working",
    file: "lib/index.js",
    from: '                results.push({ engine, status: "fail", error: r.error ?? "unknown error" });',
    to: '                results.push({ engine, status: "ok", results: 0 });',
    expect: ["HOST-013"],
  },
  {
    id: "M10",
    line: "any",
    what: "the prompt section is registered once and never refreshed",
    file: "lib/index.js",
    from: "    if (typeof refreshPrompt === \"function\") refreshPrompt();",
    to: "    if (false && typeof refreshPrompt === \"function\") refreshPrompt();",
    expect: ["HOST-014"],
    // The DSH 0.1 case checks the same refresh through installSettingsSection's
    // onChange hook, so it goes red with it.
    expectOn: { "0.1": ["HOST-014", "HOST-019"] },
  },
  {
    id: "M11",
    line: "any",
    what: "engine keys stored in the host's credentials service are ignored",
    file: "lib/index.js",
    from: "    const service = credentials();",
    to: "    const service = undefined;",
    expect: ["HOST-015"],
  },
  {
    id: "M12",
    line: "any",
    what: "the bridge's loopback fence lets every request through",
    file: "lib/index.js",
    from: "  const guard = (req, res) => {\n    if (!isLoopbackRequest(req)) {",
    to: "  const guard = (req, res) => {\n    if (false && !isLoopbackRequest(req)) {",
    expect: ["HOST-017"],
  },
  {
    id: "M13",
    line: "0.2",
    what: "the plugin stops listening for the host's volatile-update notification",
    file: "lib/index.js",
    from: '    ctx.on("loader/volatile-update", onSettingsChange);',
    to: "    void onSettingsChange;",
    // Both the cache invalidation and the prompt refresh hang off this one
    // notification, so both cases are expected to go red.
    expect: ["HOST-014", "HOST-018"],
  },
  {
    id: "M14",
    line: "0.1",
    what: "the DSH 0.1 settings section stops reporting changes back to the plugin",
    file: "lib/index.js",
    from: "      setSource: (source) => {\n        current = source;\n      },",
    to: "      setSource: () => {},",
    // setSource is how the plugin reads any live setting at all on DSH 0.1, so
    // the engine in the prompt and the settings-key priority break with it.
    expect: ["HOST-014", "HOST-015", "HOST-019"],
  },
  {
    id: "M15",
    line: "any",
    what: "a lost revision race is reported as an internal error instead of a conflict",
    file: "lib/index.js",
    from: '        if (error instanceof SettingsConflictError) {\n          return { ok: false, code: "settings-conflict", message: error.message };\n        }',
    to: "",
    expect: ["HOST-020"],
  },
  {
    id: "M16",
    line: "0.2",
    what: "a dsh peer upper bound loses its -0 and admits the next major's prereleases",
    file: "package.json",
    from: '"@deepseek-ai/dsh-tools":  "\\u003e=0.1.0-rc.6 \\u003c0.3.0-0"',
    to: '"@deepseek-ai/dsh-tools":  "\\u003e=0.1.0-rc.6 \\u003c0.3.0"',
    expect: ["HOST-021"],
  },
  {
    id: "M17",
    line: "any",
    what: "the client speaks a bridge namespace the server side does not expose",
    file: "lib/client.js",
    from: '    const NS = "free-search";',
    to: '    const NS = "free-search-renamed";',
    expect: ["HOST-022"],
  },
];

const hostRoot = process.env.DSH_HOST_ROOT;
if (!hostRoot) {
  console.error("DSH_HOST_ROOT is required (the staged host's dsh-plugin-desktop directory).");
  process.exit(1);
}

const git = (...args) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
const dirty = git("status", "--porcelain", "--", "lib", "test", "package.json").stdout.trim();
if (dirty && !process.argv.includes("--allow-dirty")) {
  console.error("refusing to run with uncommitted changes under lib/, test/ or package.json:");
  console.error(dirty);
  console.error("commit or stash them first, or pass --allow-dirty if you know what you are doing.");
  process.exit(1);
}

/** The host generation, probed the same way the cases do. */
function hostLine() {
  const probe = spawnSync(process.execPath, ["-e", `
    const { createRequire } = require("node:module");
    const required = createRequire(${JSON.stringify(path.join(hostRoot, "package.json"))});
    import(require("node:url").pathToFileURL(required.resolve("@deepseek-ai/dsh-settings")).href)
      .then((mod) => process.stdout.write(typeof mod.installSettingsSection === "function" ? "0.1" : "0.2"));
  `], { encoding: "utf8" });
  return probe.stdout.trim();
}

function failedCases() {
  // The source-mode cases are not part of this exercise; they need the outer
  // checkout and would only add noise to every line of the report.
  const env = { ...process.env, TOKENS_HOST_ROOT: hostRoot };
  delete env.TOKENS_OUTER_ROOT;
  const execution = spawnSync(process.execPath, [runner, "--host-contracts"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = `${execution.stdout ?? ""}`.split(/\r?\n/);
  return new Set(lines
    .filter((line) => line.startsWith("FAIL\t"))
    .map((line) => line.split("\t")[1])
    .filter((id) => /^HOST-\d+$/.test(id)));
}

const line = hostLine();
const selected = process.argv.slice(2).filter((value) => /^M\d+$/.test(value));
const applicable = MUTATIONS
  .filter((mutation) => selected.length === 0 || selected.includes(mutation.id))
  .filter((mutation) => mutation.line === "any" || mutation.line === line);
const skippedForLine = MUTATIONS
  .filter((mutation) => selected.length === 0 || selected.includes(mutation.id))
  .filter((mutation) => !applicable.includes(mutation));

console.log(`mutation verification on a DSH ${line} host: ${hostRoot}`);
const baseline = failedCases();
if (baseline.size > 0) {
  console.error(`the unmutated suite is already red (${[...baseline].join(", ")}); fix that first.`);
  process.exit(1);
}
console.log("baseline: every executable case is green\n");

let bad = 0;
for (const mutation of applicable) {
  const target = path.join(repoRoot, mutation.file);
  const original = readFileSync(target, "utf8");
  // A Windows checkout with core.autocrlf=true has CRLF on disk, so the
  // mutation sites are written with plain \n and retargeted here.
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const from = mutation.from.replaceAll("\n", eol);
  const to = mutation.to.replaceAll("\n", eol);
  const occurrences = original.split(from).length - 1;
  if (occurrences !== 1) {
    console.log(`UNANCHORED\t${mutation.id}\t${mutation.what}\tthe mutation site occurs ${occurrences} times in ${mutation.file}`);
    bad += 1;
    continue;
  }
  try {
    writeFileSync(target, original.replace(from, to), "utf8");
    const failed = failedCases();
    const expected = mutation.expectOn?.[line] ?? mutation.expect;
    const missed = expected.filter((id) => !failed.has(id));
    const extra = mutation.allowExtra ? [] : [...failed].filter((id) => !expected.includes(id));
    if (missed.length === 0 && extra.length === 0) {
      console.log(`CAUGHT\t${mutation.id}\t${mutation.what}\t${[...failed].sort().join(" ")}`);
    } else {
      bad += 1;
      const detail = [
        missed.length > 0 ? `idle: ${missed.join(" ")}` : "",
        extra.length > 0 ? `also red: ${extra.join(" ")}` : "",
      ].filter(Boolean).join("; ");
      console.log(`MISMATCH\t${mutation.id}\t${mutation.what}\t${detail}`);
    }
  } finally {
    writeFileSync(target, original, "utf8");
  }
}

for (const mutation of skippedForLine) {
  console.log(`SKIPPED\t${mutation.id}\t${mutation.what}\tonly meaningful on a DSH ${mutation.line} host`);
}

const residue = git("status", "--porcelain", "--", "lib", "test", "package.json").stdout.trim();
if (residue !== dirty) {
  console.error(`a mutation was not reverted:\n${residue}`);
  process.exit(1);
}
console.log(`\n${applicable.length - bad}/${applicable.length} mutations were caught by exactly the expected cases.`);
process.exit(bad > 0 ? 1 : 0);
