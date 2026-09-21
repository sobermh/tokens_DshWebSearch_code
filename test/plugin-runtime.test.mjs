import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import { ALL_ENGINES, apply } from "../lib/index.js";

const root = new URL("../", import.meta.url);

function bingHtml(count = 1, query = "query") {
  return "x".repeat(600) + Array.from({ length: count }, (_, index) =>
    `<li class="b_algo"><h2><a href="https://example.test/${encodeURIComponent(query)}/${index}">Title ${query} ${index}</a></h2><p>Relevant ${query} snippet ${index}</p></li>`
  ).join("");
}

function ddgHtml(count = 1, query = "query") {
  return "x".repeat(600) + Array.from({ length: count }, (_, index) =>
    `<div class="result results_links"><a class="result__a" href="https://ddg.test/${encodeURIComponent(query)}/${index}">DDG ${query} ${index}</a><a class="result__snippet">Relevant ${query}</a></div></div></div>`
  ).join("");
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createHost(overrides = {}, options = {}) {
  const config = {
    provider: "bing",
    cache: true,
    cacheTtl: 5,
    bingMarket: "zh-CN",
    platforms: ["github", "v2ex", "bilibili", "reddit"],
    ...overrides,
  };
  const state = {
    tools: [],
    routes: [],
    prompts: [],
    effects: [],
    warnings: [],
    credentialCalls: [],
    revision: 1,
    disposed: 0,
  };
  const secretValues = options.secretValues ?? {};
  const descriptor = () => ({
    ns: "free-search",
    schema: {},
    value: options.descriptorValue ?? { ...config },
    secrets: Object.entries(secretValues).map(([key, value]) => ({ path: [key], set: Boolean(value) })),
    revision: state.revision,
  });
  const settings = {
    writable: true,
    register() {
      return {
        get: () => config,
        watch: () => () => { state.disposed += 1; },
      };
    },
    describe() {
      return [descriptor(), { ns: "other", value: { private: true }, revision: 1 }];
    },
    async mutate(ns, operations, expectedRevision) {
      if (options.mutateDelay) await new Promise((resolve) => setTimeout(resolve, 10));
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw new SettingsConflictError(ns, expectedRevision, state.revision);
      }
      for (const operation of operations) {
        if (operation.op === "set") config[operation.path[0]] = operation.value;
      }
      state.revision += 1;
    },
  };
  const services = {
    settings,
    webServer: {
      register(route) {
        state.routes.push(route);
        return () => { state.disposed += 1; };
      },
    },
    tools: {
      register(tool) {
        state.tools.push(tool);
        return () => { state.disposed += 1; };
      },
    },
    systemPrompt: {
      section(prompt) {
        state.prompts.push(prompt);
        return () => { state.disposed += 1; };
      },
    },
  };
  const enabled = new Set(options.services ?? Object.keys(services));
  const ctx = {
    fiber: { state: 0 },
    logger: { warn: (message) => state.warnings.push(message) },
    get(name) {
      if (name !== "credentials" || !options.credentials) return undefined;
      return {
        async resolve(key) {
          state.credentialCalls.push(key);
          return { value: options.credentials[key] ?? "" };
        },
      };
    },
    web: {
      registerSearchProvider(provider) {
        state.provider = provider;
      },
    },
    effect(setup) {
      const dispose = setup();
      if (typeof dispose === "function") state.effects.push(dispose);
    },
    inject(names, callback) {
      if (!names.every((name) => enabled.has(name))) return;
      callback({
        ...ctx,
        ...Object.fromEntries([...enabled].filter((name) => services[name]).map((name) => [name, services[name]])),
      });
    },
  };
  apply(ctx, config);
  return Object.assign(state, { config, settings });
}

function getTool(host, name) {
  const tool = host.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function request(body, options = {}) {
  const req = Readable.from([Buffer.from(body)]);
  req.method = options.method ?? "POST";
  req.headers = options.headers ?? { host: "127.0.0.1:43120" };
  req.socket = { remoteAddress: options.remoteAddress ?? "127.0.0.1" };
  return req;
}

async function callRoute(route, body, options) {
  let status;
  let headers;
  let payload;
  await route.handler(request(body, options), {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(value) {
      payload = value;
    },
  });
  return { status, headers, body: JSON.parse(payload) };
}

test("installed DSH contracts load and register provider, tools, routes, and prompt", async () => {
  const settingsPackage = JSON.parse(await readFile(new URL("node_modules/@deepseek-ai/dsh-settings/package.json", root)));
  const toolsPackage = JSON.parse(await readFile(new URL("node_modules/@deepseek-ai/dsh-tools/package.json", root)));
  assert.equal(settingsPackage.version, "0.1.0-rc.7");
  assert.equal(toolsPackage.version, "0.1.0-rc.7");

  const host = createHost();
  assert.equal(host.provider.id, "ddg");
  assert.deepEqual(host.tools.map((tool) => tool.name), ["free_search_test", "platform_search", "advanced_search"]);
  assert.deepEqual(host.routes.map((route) => route.path), [
    "/api/tokens-dsh-web-search-settings/describe",
    "/api/tokens-dsh-web-search-settings/mutate",
    "/api/tokens-dsh-web-search-settings/raw-search",
  ]);
  assert.equal(host.prompts.length, 1);
});

test("invalid provider falls back safely and cache TTL is clamped to zero through five minutes", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    return new Response(bingHtml(1, new URL(url).searchParams.get("q")));
  };
  const invalid = createHost({ provider: "unknown", cacheTtl: -3 });
  assert.equal((await invalid.provider.search({ query: "fallback", maxResults: 1 })).provider, "bing");
  await invalid.provider.search({ query: "fallback", maxResults: 1 });
  assert.ok(calls >= 2, "negative TTL must disable caching");

  calls = 0;
  let now = 1_000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const clamped = createHost({ cacheTtl: 99 });
    assert.equal((await clamped.provider.search({ query: "ttl", maxResults: 1 }))._cache, "miss");
    assert.equal((await clamped.provider.search({ query: "ttl", maxResults: 1 }))._cache, "hit");
    now += 300_001;
    assert.equal((await clamped.provider.search({ query: "ttl", maxResults: 1 }))._cache, "miss");
    assert.equal(calls, 2);
  } finally {
    Date.now = originalNow;
  }
});

test("settings API key wins over credentials and environment without leaking", async () => {
  process.env.EXA_API_KEY = "key-env";
  let authorization;
  globalThis.fetch = async (_url, init) => {
    authorization = init.headers.authorization;
    return jsonResponse({ results: [{ url: "https://exa.test/1", title: "Exa", highlights: ["snippet"] }] });
  };
  try {
    const host = createHost(
      { exaApiKey: "key-settings" },
      { credentials: { EXA_API_KEY: "key-credentials" } },
    );
    const result = await host.provider.search({ query: "key precedence", engine: "exa", maxResults: 1 });
    assert.equal(result.provider, "exa");
    assert.equal(authorization, "Bearer key-settings");
    assert.equal(host.credentialCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /key-settings|key-credentials|key-env/);
  } finally {
    delete process.env.EXA_API_KEY;
  }
});

test("provider and advanced_search reject blank queries and clamp result count", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    return new Response(bingHtml(12, new URL(url).searchParams.get("q")));
  };
  const host = createHost();
  await assert.rejects(() => host.provider.search({ query: "   " }), /query is required/);
  const advanced = getTool(host, "advanced_search");
  await assert.rejects(() => advanced.execute({ query: "   " }), /query is required/);
  assert.equal(calls, 0);
  assert.equal((await advanced.execute({ query: "default" })).sources.length, 5);
  assert.equal((await advanced.execute({ query: "maximum", maxResults: 100 })).sources.length, 10);
});

test("all engine failures retain the real per-engine reasons", async () => {
  globalThis.fetch = async () => new Response("upstream unavailable", { status: 503 });
  const host = createHost({ searxngInstances: ["https://searx.test"] });
  await assert.rejects(
    () => host.provider.search({ query: "all fail", maxResults: 1 }),
    (error) => /all search engines failed/.test(error.message)
      && /bing: HTTP 503/.test(error.message)
      && /anysearch: AnySearch API error/.test(error.message),
  );
});

test("advanced_search explicit engine wins and forwards the time filter", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(String(url).startsWith("https://html.duckduckgo.com")
      ? ddgHtml(1, "explicit")
      : bingHtml(1, "bing"));
  };
  const host = createHost({ provider: "bing" });
  const result = await getTool(host, "advanced_search").execute({
    query: "explicit",
    engine: "ddg",
    timeRange: "week",
  });
  assert.equal(result.provider, "ddg");
  assert.match(urls[0], /^https:\/\/html\.duckduckgo\.com/);
  assert.match(urls[0], /[?&]df=w(?:&|$)/);
});

test("free_search_test reports all ten engines without stopping after failures", async () => {
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes("bing.com")) return new Response(bingHtml(1, "diagnostic"));
    if (href.includes("duckduckgo.com")) return new Response(ddgHtml(1, "diagnostic"));
    if (href.includes("format=json")) return jsonResponse({ results: [{ url: "https://searx.test/1", title: "SearX" }] });
    if (href.includes("anysearch")) return jsonResponse({ code: 0, data: { results: [{ url: "https://any.test/1", title: "Any" }] } });
    return new Response("unavailable", { status: 503 });
  };
  const host = createHost({ searxngInstances: ["https://searx.test"] });
  const result = await getTool(host, "free_search_test").execute({ query: "diagnostic" });
  assert.equal(result.results.length, 10);
  assert.deepEqual(result.results.map((item) => item.engine), ALL_ENGINES);
  assert.equal(result.results.at(-1).status, "fail");
});

test("free_search_test returns success when an empty engine result succeeds on retry", async () => {
  let ddgCalls = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/html\.duckduckgo\.com/);
    ddgCalls += 1;
    return new Response(ddgCalls === 1 ? "x".repeat(600) : ddgHtml(1, "retry"));
  };
  const host = createHost();
  const result = await getTool(host, "free_search_test").execute({ engines: ["ddg"], query: "retry" });
  assert.equal(ddgCalls, 2);
  assert.deepEqual(result.results, [{
    engine: "ddg",
    status: "ok",
    results: 1,
    sampleTitle: "DDG retry 0",
    sampleUrl: "https://ddg.test/retry/0",
  }]);
});

test("free_search_test reports a clear failure when the retry is still empty", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("x".repeat(600));
  };
  const host = createHost();
  const result = await getTool(host, "free_search_test").execute({ engines: ["ddg"], query: "empty" });
  assert.equal(calls, 2);
  assert.deepEqual(result.results, [{
    engine: "ddg",
    status: "fail",
    error: "ddg returned 0 results after retry",
  }]);
});

test("cache hits within TTL and cache=false or TTL zero bypasses storage", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(bingHtml(1, "cache"));
  };
  const enabled = createHost();
  assert.equal((await enabled.provider.search({ query: "same", maxResults: 1 }))._cache, "miss");
  assert.equal((await enabled.provider.search({ query: "same", maxResults: 1 }))._cache, "hit");
  assert.equal(calls, 1);

  for (const config of [{ cache: false }, { cacheTtl: 0 }]) {
    calls = 0;
    const disabled = createHost(config);
    assert.equal((await disabled.provider.search({ query: "off", maxResults: 1 }))._cache, "miss");
    assert.equal((await disabled.provider.search({ query: "off", maxResults: 1 }))._cache, "miss");
    assert.equal(calls, 2);
  }
});

test("cache key separates result count, time range, and preferred engine", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    const href = String(url);
    if (href.startsWith("https://www.bing.com")) return new Response(bingHtml(6, "key"));
    if (href.startsWith("https://html.duckduckgo.com")) return new Response(ddgHtml(6, "key"));
    return new Response("unavailable", { status: 503 });
  };
  const host = createHost({ searxngInstances: ["https://searx.test"] });
  await host.provider.search({ query: "key", maxResults: 3 });
  const afterCountThree = calls;
  await host.provider.search({ query: "key", maxResults: 5 });
  assert.ok(calls > afterCountThree);
  const afterCountFive = calls;
  await host.provider.search({ query: "key", maxResults: 5, timeRange: "week", engine: "ddg" });
  assert.ok(calls > afterCountFive);
  const afterTimeRange = calls;
  await host.provider.search({ query: "key", maxResults: 5, timeRange: "week", engine: "bing" });
  assert.ok(calls > afterTimeRange);
});

test("fallback cache expires after one fifth TTL and allows the preferred engine to recover", async () => {
  let now = 1_000;
  let bingAvailable = false;
  let calls = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    calls += 1;
    const href = String(url);
    if (href.includes("bing.com")) {
      return bingAvailable ? new Response(bingHtml(1, "restored")) : new Response("bad", { status: 503 });
    }
    if (href.includes("anysearch")) {
      return jsonResponse({ code: 0, data: { results: [{ url: "https://fallback.test", title: "fallback" }] } });
    }
    return new Response("bad", { status: 503 });
  };
  try {
    const host = createHost({ searxngInstances: ["https://searx.test"] });
    assert.equal((await host.provider.search({ query: "fallback", maxResults: 1 })).provider, "anysearch");
    const beforeHit = calls;
    now += 59_000;
    assert.equal((await host.provider.search({ query: "fallback", maxResults: 1 }))._cache, "hit");
    assert.equal(calls, beforeHit);
    now += 2_000;
    bingAvailable = true;
    assert.equal((await host.provider.search({ query: "fallback", maxResults: 1 })).provider, "bing");
    assert.ok(calls > beforeHit);
  } finally {
    Date.now = originalNow;
  }
});

test("cache uses 50-entry LRU and returns an isolated sources array", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    const query = new URL(url).searchParams.get("q");
    return new Response(bingHtml(1, query));
  };
  const host = createHost();
  for (let index = 1; index <= 50; index += 1) {
    await host.provider.search({ query: `q${index}`, maxResults: 1 });
  }
  const q2 = await host.provider.search({ query: "q2", maxResults: 1 });
  q2.sources.push({ url: "https://pollution.test" });
  await host.provider.search({ query: "q51", maxResults: 1 });
  const beforeQ1 = calls;
  await host.provider.search({ query: "q1", maxResults: 1 });
  assert.equal(calls, beforeQ1 + 1);
  const beforeQ2 = calls;
  const q2Again = await host.provider.search({ query: "q2", maxResults: 1 });
  assert.equal(calls, beforeQ2);
  assert.equal(q2Again.sources.some((source) => source.url === "https://pollution.test"), false);
});

test("bridge describe exposes only free-search and redacts secret values", async () => {
  const host = createHost(
    {},
    {
      descriptorValue: { provider: "bing" },
      secretValues: { exaApiKey: "top-secret", tavilyApiKey: "" },
    },
  );
  const route = host.routes.find((candidate) => candidate.path.endsWith("/describe"));
  const response = await callRoute(route, "{}");
  assert.equal(response.status, 200);
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.deepEqual(response.body.value.namespaces.map((entry) => entry.ns), ["free-search"]);
  assert.doesNotMatch(JSON.stringify(response.body), /top-secret/);
  assert.deepEqual(response.body.value.namespaces[0].secrets, [
    { path: ["exaApiKey"], set: true },
    { path: ["tavilyApiKey"], set: false },
  ]);
});

test("bridge concurrent mutation rejects the stale revision", async () => {
  const host = createHost({}, { mutateDelay: true });
  const route = host.routes.find((candidate) => candidate.path.endsWith("/mutate"));
  const requests = ["ddg", "bing"].map((provider) => callRoute(route, JSON.stringify({
    ns: "free-search",
    expectedRevision: 1,
    ops: [{ op: "set", path: ["provider"], value: provider }],
  })));
  const responses = await Promise.all(requests);
  assert.equal(responses.filter((response) => response.body.ok).length, 1);
  assert.equal(responses.filter((response) => response.body.code === "settings-conflict").length, 1);
});

test("bridge rejects malformed and oversized JSON without side effects", async () => {
  let searches = 0;
  globalThis.fetch = async () => {
    searches += 1;
    return new Response(bingHtml());
  };
  const host = createHost();
  for (const suffix of ["/mutate", "/raw-search"]) {
    const route = host.routes.find((candidate) => candidate.path.endsWith(suffix));
    assert.equal((await callRoute(route, "{bad")).status, 400);
    assert.equal((await callRoute(route, "x".repeat(65_537))).status, 400);
  }
  assert.equal(searches, 0);
});

test("bridge security guard rejects remote, forged, cross-site, cross-origin, and non-POST requests", async () => {
  let searches = 0;
  globalThis.fetch = async () => {
    searches += 1;
    return new Response(bingHtml());
  };
  const host = createHost();
  for (const route of host.routes) {
    assert.equal((await callRoute(route, "{}", { remoteAddress: "192.168.1.20" })).status, 403);
    assert.equal((await callRoute(route, "{}", { headers: { host: "evil.test" } })).status, 403);
    assert.equal((await callRoute(route, "{}", { headers: { host: "127.0.0.1:43120", "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await callRoute(route, "{}", { headers: { host: "127.0.0.1:43120", origin: "http://evil.test" } })).status, 403);
    assert.equal((await callRoute(route, "{}", { method: "GET" })).status, 405);
  }
  assert.equal(searches, 0);
});

test("bridge raw-search clamps parameters and reports accurate cache state", async () => {
  globalThis.fetch = async () => new Response(bingHtml(12, "raw"));
  const host = createHost();
  const route = host.routes.find((candidate) => candidate.path.endsWith("/raw-search"));
  for (const [value, expected] of [[0, 5], [-1, 1], [100, 10], ["abc", 5]]) {
    const response = await callRoute(route, JSON.stringify({ query: `raw-${value}`, maxResults: value }));
    assert.equal(response.body.ok, true);
    assert.equal(response.body.value.sources.length, expected);
    assert.equal(response.body.value.cache, "miss");
  }
  const cached = await callRoute(route, JSON.stringify({ query: "raw-0", maxResults: 0 }));
  assert.equal(cached.body.value.cache, "hit");
});

test("optional services degrade safely and registered effects dispose cleanly", async () => {
  globalThis.fetch = async () => new Response(bingHtml(1, "core"));
  for (const services of [[], ["tools"], ["settings"], ["systemPrompt"]]) {
    const host = createHost({}, { services });
    assert.equal((await host.provider.search({ query: "core", maxResults: 1 })).sources.length, 1);
  }

  const complete = createHost();
  assert.equal(complete.routes.length, 3);
  assert.equal(complete.tools.length, 3);
  assert.equal(complete.prompts.length, 1);
  for (const dispose of complete.effects.reverse()) dispose();
  assert.ok(complete.disposed >= 6);
});
