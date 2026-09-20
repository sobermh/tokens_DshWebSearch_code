import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { searchBilibili, searchGithub, searchPlatform, searchReddit, searchV2ex } from "../lib/index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("GitHub 仓库搜索解析名称、描述和 star", async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return json({ items: [{ html_url: "https://github.com/a/b", full_name: "a/b", description: "Harness", stargazers_count: 42 }] });
  };
  const result = await searchGithub("deepseek harness", 5);
  assert.equal(requestedUrl.searchParams.get("q"), "deepseek harness");
  assert.equal(requestedUrl.searchParams.get("per_page"), "5");
  assert.deepEqual(result.sources, [{ url: "https://github.com/a/b", title: "a/b", snippet: "Harness ⭐42" }]);
});

test("V2EX 只返回标题或正文命中的热门主题", async () => {
  globalThis.fetch = async () => json([
    { id: 1, title: "Agent news", content: "Other" },
    { id: 2, title: "Other", content: "An AGENT discussion" },
    { id: 3, title: "Unrelated", content: "No match" },
  ]);
  const result = await searchV2ex("agent", 5);
  assert.deepEqual(result.sources.map((source) => source.url), ["https://www.v2ex.com/t/1", "https://www.v2ex.com/t/2"]);
});

test("Bilibili 去除标题标签并限制摘要与结果数量", async () => {
  globalThis.fetch = async () => json({ code: 0, data: { result: [{ data: [
    { arcurl: "https://b.example/1", title: "<em>DeepSeek</em> one", desc: "x".repeat(250) },
    { arcurl: "https://b.example/2", title: "Two", desc: "second" },
  ] }] } });
  const result = await searchBilibili("DeepSeek", 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].title, "DeepSeek one");
  assert.equal(result.sources[0].snippet.length, 200);
});

test("Reddit 解析标题和正文并忽略缺少 URL 的条目", async () => {
  globalThis.fetch = async () => json({ data: { children: [
    { data: { url: "https://r.example/1", title: "Agent", selftext: "Body" } },
    { data: { title: "Missing URL", selftext: "Ignored" } },
  ] } });
  const result = await searchReddit("AI agent", 5);
  assert.deepEqual(result.sources, [{ url: "https://r.example/1", title: "Agent", snippet: "Body" }]);
});

test("平台适配器拒绝未知平台并透传上游 HTTP 错误", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return json({}, 429);
  };
  await assert.rejects(searchPlatform("unknown", "agent", 5), /unknown platform: unknown/);
  assert.equal(calls, 0);
  await assert.rejects(searchPlatform("github", "agent", 5), /GitHub API error \(HTTP 429\)/);
  assert.equal(calls, 1);
});
