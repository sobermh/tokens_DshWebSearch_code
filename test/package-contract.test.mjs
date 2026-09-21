import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("运行时和 package.json 声明 Node.js 20 最低版本", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.engines.node, ">=20");
  assert.ok(typeof AbortSignal.any === "function");
  assert.ok(typeof AbortSignal.timeout === "function");
});

test("npm files 清单仅包含插件运行必需文件", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.deepEqual(new Set(pkg.files), new Set([
    "lib/index.js",
    "lib/hedged-race.js",
    "lib/client.js",
    "cordis.patch.yml",
  ]));
  for (const entry of pkg.files) {
    assert.doesNotMatch(entry, /(?:^|\/)(?:test|tests|\.playwright-mcp|\.env|settings\.ya?ml)(?:\/|$)/i);
  }
});

test("npm pack dry-run 只列出发布所需内容", () => {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm pack --dry-run"] : ["pack", "--dry-run"];
  const result = spawnSync(command, args, {
    cwd: fileURLToPath(root),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = `${result.stdout}\n${result.stderr}`.replaceAll("\\", "/");
  for (const entry of ["lib/index.js", "lib/client.js", "lib/hedged-race.js", "cordis.patch.yml", "package.json", "LICENSE"]) {
    assert.match(output, new RegExp(entry.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(output, /(?:^|[\s/])(?:test|tests|\.playwright-mcp|\.env|settings\.ya?ml)(?:[\s/]|$)/im);
});
