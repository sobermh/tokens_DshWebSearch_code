import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import {
  searchAnysearch,
  searchBing,
  searchDeepSeekOfficial,
  searchDdgHtml,
  searchDdgLite,
  searchExa,
  searchExaMCP,
  searchKeenable,
  searchPerplexity,
  searchSearxng,
  searchTavily,
} from "../lib/index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function paddedHtml(body, status = 200) {
  return new Response(`${body}<!--${"x".repeat(600)}-->`, {
    status,
    headers: { "content-type": "text/html" },
  });
}

test("Bing 使用中文市场参数并解析、去重和限制结果", async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return paddedHtml(`
      <li class="b_algo"><h2><a href="https://one.example/">结果一</a></h2><p>摘要一</p></li>
      <li class="b_algo"><h2><a href="https://one.example/">重复</a></h2><p>重复摘要</p></li>
      <li class="b_algo"><h2><a href="https://two.example/">结果二</a></h2><p>摘要二</p></li>`);
  };

  const result = await searchBing("中文 查询", 2, { bingMarket: "zh-CN" });
  assert.equal(requestedUrl.searchParams.get("q"), "中文 查询");
  assert.equal(requestedUrl.searchParams.get("mkt"), "zh-CN");
  assert.deepEqual(result.sources, [
    { url: "https://one.example/", title: "结果一", snippet: "摘要一" },
    { url: "https://two.example/", title: "结果二", snippet: "摘要二" },
  ]);
});

test("Bing 页面格式变化时返回零条结果供回退链判定", async () => {
  globalThis.fetch = async () => paddedHtml("<main>new markup without b_algo</main>");
  const result = await searchBing("layout probe", 5, { bingMarket: "zh-CN" });
  assert.deepEqual(result.sources, []);
});

test("DuckDuckGo HTML 解析跳转链接并发送时间与地区参数", async () => {
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return paddedHtml(`
      <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Doc &amp; API</a>
      <a class="result__snippet">Useful &lt;b&gt;text&lt;/b&gt;</a></div></div></div>`);
  };

  const result = await searchDdgHtml("agent", 3, { region: "cn-zh", timeRange: { days: 7 } });
  assert.equal(requestedUrl.searchParams.get("kl"), "cn-zh");
  assert.equal(requestedUrl.searchParams.get("df"), "w");
  assert.deepEqual(result.sources, [
    { url: "https://example.com/doc", title: "Doc & API", snippet: "Useful <b>text</b>" },
  ]);
});

test("DuckDuckGo Lite 将摘要与对应结果配对并限制数量", async () => {
  globalThis.fetch = async () => paddedHtml(`
    <a class="result-link" href="https://one.example">One</a>
    <td class="result-snippet">First summary</td>
    <a class="result-link" href="https://two.example">Two</a>
    <td class="result-snippet">Second summary</td>`);

  const result = await searchDdgLite("OpenAI", 1, { timeRange: { days: 1 } });
  assert.deepEqual(result.sources, [
    { url: "https://one.example", title: "One", snippet: "First summary" },
  ]);
});

test("AnySearch 解析业务结果并区分 HTTP 与业务错误", async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return json({ code: 0, data: { results: [{ url: "https://a.example", title: "A", snippet: "S" }] } });
  };
  assert.deepEqual((await searchAnysearch("agent", 3)).sources, [
    { url: "https://a.example", title: "A", snippet: "S" },
  ]);
  assert.deepEqual(JSON.parse(request.init.body), { query: "agent", max_results: 3 });

  globalThis.fetch = async () => json({ code: 42, message: "quota" });
  await assert.rejects(searchAnysearch("agent", 3), /AnySearch API error: quota/);
  globalThis.fetch = async () => json({}, 503);
  await assert.rejects(searchAnysearch("agent", 3), /HTTP 503/);
});

test("SearXNG 首实例失败后切换并聚合全失败原因", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://first.example")) return json({}, 429);
    return json({ results: [{ url: "https://result.example", title: "Result", content: "Summary" }] });
  };
  const options = { searxngInstances: ["https://first.example", "https://second.example"], timeRange: { days: 30 } };
  const result = await searchSearxng("agent", 5, options);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /time_range=month/);
  assert.deepEqual(result.sources, [{ url: "https://result.example", title: "Result", snippet: "Summary" }]);

  const failingOptions = {
    searxngInstances: ["https://first.example", "https://second.example", "https://empty.example"],
    timeRange: { days: 30 },
  };
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://first.example")) return json({}, 429);
    if (String(url).startsWith("https://second.example")) return json({ nope: true });
    return json({ results: [] });
  };
  await assert.rejects(searchSearxng("agent", 5, failingOptions), (error) => {
    assert.match(error.message, /first\.example: HTTP 429/);
    assert.match(error.message, /second\.example: invalid JSON/);
    assert.match(error.message, /empty\.example: 0 results/);
    assert.ok(error.message.length <= 333);
    return true;
  });
});

test("Exa MCP 发送正确工具调用并解析来源字段", async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    const payload = {
      result: {
        content: [{ type: "text", text: "Title: Agent\nURL: https://exa.example/a\nPublished: 2026-09-01\nHighlights:\nFirst\nSecond" }],
      },
    };
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const result = await searchExaMCP("AI agent", 3);
  const body = JSON.parse(request.init.body);
  assert.equal(body.params.name, "web_search_exa");
  assert.deepEqual(body.params.arguments, { query: "AI agent", numResults: 3 });
  assert.deepEqual(result.sources, [{
    url: "https://exa.example/a",
    title: "Agent",
    snippet: "First Second",
    publishedAt: "2026-09-01",
  }]);
});

test("Exa REST 需要密钥并以 Bearer 请求且过滤无摘要结果", async () => {
  let request;
  let called = false;
  globalThis.fetch = async (url, init) => {
    called = true;
    request = { url, init };
    return json({ results: [
      { url: "https://exa.example/a", title: "A", highlights: ["Useful"], publishedDate: "2026-09-01" },
      { url: "https://exa.example/b", title: "B", highlights: [] },
    ] });
  };
  await assert.rejects(searchExa("agent", 3, "", undefined), /requires EXA_API_KEY/);
  assert.equal(called, false);
  const result = await searchExa("agent", 3, "secret", { after: "2026-07-01" });
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(JSON.parse(request.init.body).startPublishedDate, "2026-07-01");
  assert.equal(result.sources.length, 1);
});

test("Tavily 在无 Key 和有 Key 时使用对应认证方式", async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push(init);
    return json({ results: [{ url: "https://tavily.example", title: "T", content: "Summary" }] });
  };
  await searchTavily("DeepSeek", 5, "", { days: 7 });
  await searchTavily("DeepSeek", 5, "secret", { days: 7 });
  assert.equal(requests[0].headers["x-tavily-access-mode"], "keyless");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].headers.authorization, "Bearer secret");
  assert.equal(requests[1].headers["x-tavily-access-mode"], undefined);
  assert.equal(JSON.parse(requests[0].body).time_range, "week");
});

test("Keenable 根据 Key 选择 MCP 或 REST 并传递时间范围", async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/mcp")) {
      return json({ result: { content: [{ type: "text", text: "Title: Agent\nURL: https://k.example/a\nPublished: 2026-09-01\nSnippets:\nOne\nTwo" }] } });
    }
    return json({ results: [{ url: "https://k.example/b", title: "REST", description: "Description" }] });
  };
  const keyless = await searchKeenable("agent", 3, "", { days: 0.5 });
  const keyed = await searchKeenable("agent", 3, "secret", { after: "2026-07-01" });
  assert.equal(JSON.parse(requests[0].init.body).params.arguments.published_after, "12h");
  assert.equal(requests[1].init.headers["x-api-key"], "secret");
  assert.equal(JSON.parse(requests[1].init.body).published_after, "2026-07-01");
  assert.equal(keyless.sources[0].url, "https://k.example/a");
  assert.equal(keyed.sources[0].snippet, "Description");
});

test("Perplexity 缺 Key 不联网，有 Key 时解析答案和去重引用", async () => {
  let calls = 0;
  let request;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    request = { url, init };
    return json({ choices: [{ message: { content: "Answer" } }], citations: ["https://p.example", "https://p.example"] });
  };
  await assert.rejects(searchPerplexity("agent", 5, ""), /requires PERPLEXITY_API_KEY/);
  assert.equal(calls, 0);
  const result = await searchPerplexity("agent", 5, "secret");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.equal(result.content, "Answer");
  assert.deepEqual(result.sources, [{ url: "https://p.example", snippet: "Answer" }]);
});

test("DeepSeek Official 缺 Key 不联网，有 Key 时解析并去重搜索来源", async () => {
  let calls = 0;
  let request;
  globalThis.fetch = async (url, init) => {
    calls += 1;
    request = { url, init };
    return json({ content: [
      { type: "text", citations: [{ url: "https://d.example", cited_text: "Quoted" }] },
      { type: "web_search_tool_result", content: [
        { type: "web_search_result", url: "https://d.example", title: "D", page_age: "2026-09-01" },
        { type: "web_search_result", url: "https://d.example", title: "Duplicate" },
      ] },
    ] });
  };
  await assert.rejects(searchDeepSeekOfficial("agent", 5, ""), /requires DEEPSEEK_API_KEY/);
  assert.equal(calls, 0);
  const result = await searchDeepSeekOfficial("agent", 5, "secret");
  assert.equal(request.init.headers["x-api-key"], "secret");
  assert.equal(JSON.parse(request.init.body).tools[0].name, "web_search");
  assert.deepEqual(result.sources, [{
    url: "https://d.example",
    title: "D",
    snippet: "Quoted",
    publishedAt: "2026-09-01",
  }]);
});
