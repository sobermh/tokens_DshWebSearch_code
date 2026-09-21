// 发布校验的回归测试：把"发错 registry / 发错版本 / 标签对不上"三类事故钉死。
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validateRelease } from "../scripts/validate-release.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const baseline = () => ({
  name: "tokens-dsh-web-search",
  version: "0.2.0",
  publishConfig: { registry: "https://npm.tokensapi.ai/" },
});

test("仓库当前的 package.json 自身必须能通过校验", () => {
  assert.equal(
    validateRelease(manifest, `v${manifest.version}`),
    manifest.version,
  );
});

test("包名被改动时拒绝发布", () => {
  const m = { ...baseline(), name: "tokens-dsh-web-search-fork" };
  assert.throws(() => validateRelease(m, "v0.2.0"), /Unexpected release package name/);
});

test("缺少 publishConfig 时拒绝发布", () => {
  const m = baseline();
  delete m.publishConfig;
  assert.throws(() => validateRelease(m, "v0.2.0"), /private registry/);
});

test("指向公共 registry 时拒绝发布", () => {
  const m = { ...baseline(), publishConfig: { registry: "https://registry.npmjs.org/" } };
  assert.throws(() => validateRelease(m, "v0.2.0"), /private registry/);
});

test("显式 access: public 时拒绝发布", () => {
  const m = {
    ...baseline(),
    publishConfig: { registry: "https://npm.tokensapi.ai/", access: "public" },
  };
  assert.throws(() => validateRelease(m, "v0.2.0"), /private registry/);
});

test("预发布版本不允许占用 latest", () => {
  const m = { ...baseline(), version: "0.2.0-rc.1" };
  assert.throws(() => validateRelease(m, "v0.2.0-rc.1"), /Only stable versions/);
});

test("标签与 package.json 版本不一致时拒绝发布", () => {
  assert.throws(() => validateRelease(baseline(), "v0.1.9"), /must match package\.json version/);
});

test("缺少标签参数时拒绝发布", () => {
  assert.throws(() => validateRelease(baseline(), undefined), /must match package\.json version/);
});
