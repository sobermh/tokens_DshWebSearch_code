import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Config } from "../lib/index.js";

const root = new URL("../", import.meta.url);

function schemaDefault(schema, key) {
  const json = schema.toJSON();
  const object = json.refs[String(json.uid)];
  return json.refs[String(object.dict[key])].meta.default;
}

test("补丁接管原生 web_search provider 并禁用原生 DeepSeek provider", async () => {
  const patch = await readFile(new URL("cordis.patch.yml", root), "utf8");
  assert.match(patch, /- id: web-search-free\s+[\s\S]*?name: tokens-dsh-web-search/);
  assert.match(patch, /- id: web\s+config:\s+searchProvider: ddg/);
  assert.match(patch, /- id: web-search-deepseek\s+disabled: true/);
  assert.match(patch, /- id: tool-web\s+disabled: false\s+config:\s+fetch: false\s+searchTimeoutMs: 60000/);
});

test("首次启动默认使用 Bing 中文市场并启用缓存", () => {
  assert.equal(schemaDefault(Config, "provider"), "bing");
  assert.equal(schemaDefault(Config, "bingMarket"), "zh-CN");
  assert.equal(schemaDefault(Config, "lang"), "zh");
  assert.equal(schemaDefault(Config, "cache"), true);
  assert.equal(schemaDefault(Config, "cacheTtl"), 5);
});
