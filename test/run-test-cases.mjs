import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Host fixtures are materialized in an isolated temporary directory, never in test/.
const HOST_SPEC_SOURCE = `import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import WebRuntime from "@deepseek-ai/dsh-web";
import * as ToolWeb from "@deepseek-ai/dsh-tool-web";
import { CommandUiRuntime } from "@tokens-host/command-ui";
import { LocaleRuntime } from "@tokens-host/locale";
import * as WebSearchPlugin from "@tokens-web-search/plugin";
function bingHtml(query) {
    return "x".repeat(600) + [
        \`<li class="b_algo"><h2><a href="https://results.test/\${query}">\${query}</a></h2><p>\${query} snippet</p></li>\`,
        \`<li class="b_algo"><h2><a href="https://results.test/shared">shared</a></h2><p>shared snippet</p></li>\`,
    ].join("");
}
describe("real TokensHarness web_search integration", () => {
    it("registers the client command with real commandUi and locale and removes it on unload", async () => {
        const ctx = new Context();
        const locale = new LocaleRuntime(ctx);
        ctx.provide("locale", locale);
        let source;
        ctx.provide("inputTriggers", {
            registerSource(value) { source = value; return () => { source = undefined; }; },
        });
        ctx.provide("sessions", { subagentAddress: () => undefined });
        const commands = { list: async () => ({ ok: true, value: [] }) };
        ctx.provide("remote", { commands, $on: () => () => { } });
        ctx.provide("remote.commands", commands);
        const commandFiber = ctx.plugin(CommandUiRuntime);
        await commandFiber.await();
        let client;
        vm.runInNewContext(await readFile(path.join(process.env.TOKENS_WEB_SEARCH_ROOT, "lib", "client.js"), "utf8"), {
            window: { __ModuleLoader__: { load(value) { client = value.factory(); } } },
        });
        const clientFiber = ctx.plugin(client);
        await clientFiber.await();
        const session = { sessionId: "client-search-test" };
        const request = { query: "tokens-dsh-web-search", position: "leading", drilled: false, signal: new AbortController().signal };
        try {
            locale.setLocale("en");
            expect(await source.candidates(session, request)).toEqual([
                { name: "tokens-dsh-web-search", description: "Switch web search engine" },
            ]);
            locale.setLocale("zh");
            expect(await source.candidates(session, request)).toEqual([
                { name: "tokens-dsh-web-search", description: "切换搜索引擎" },
            ]);
            await clientFiber.dispose();
            expect(await source.candidates(session, request)).toEqual([]);
            // The dictionary seat is released as well as the command contribution.
            const dispose = locale.register("tokens-dsh-web-search", { zh: {}, en: {} });
            dispose();
        }
        finally {
            await clientFiber.dispose();
            await commandFiber.dispose();
        }
    });
    it("mounts the plugin provider and executes concurrent deduplicated queries through tool-web", async () => {
        const outerRoot = process.env.TOKENS_OUTER_ROOT;
        if (!outerRoot)
            throw new Error("TOKENS_OUTER_ROOT is required");
        const toolWebPackage = JSON.parse(await readFile(path.join(outerRoot, "desktop", "deepseek-harness", "packages", "web", "tool-web", "package.json"), "utf8"));
        expect(toolWebPackage.version).toBe("0.1.5-rc.2");
        const settingsPatch = await readFile(path.join(outerRoot, "desktop", "patches", "dsh-settings@0.1.5-rc.1.patch"), "utf8");
        expect(settingsPatch).toContain("function settingsNamespace(value)");
        expect(settingsPatch).toContain("function installSettingsSection(ctx, ns, schema, entry, hooks)");
        const started = [];
        vi.stubGlobal("fetch", vi.fn(async (url) => {
            const query = new URL(String(url)).searchParams.get("q") ?? "";
            started.push(query);
            return new Response(bingHtml(query));
        }));
        const ctx = new Context();
        await ctx.plugin(SystemPrompt);
        await ctx.plugin(ToolRuntime);
        await ctx.plugin(WebRuntime, { searchProvider: "ddg" });
        const providerFiber = await ctx.plugin(WebSearchPlugin, {
            provider: "bing",
            cache: false,
            cacheTtl: 0,
            bingMarket: "zh-CN",
            platforms: [],
        });
        const toolFiber = await ctx.plugin(ToolWeb, {
            fetch: false,
            search: true,
            searchMaxQueries: 4,
            searchMaxResults: 5,
            searchTimeoutMs: 60_000,
        });
        try {
            expect(ctx.tools.schemas().map((schema) => schema.name)).toContain("web_search");
            expect(ctx.tools.schemas().map((schema) => schema.name)).not.toContain("web_fetch");
            expect(ctx.tools.get("web_search")?.timeoutMs).toBe(60_000);
            const result = await ctx.tools.execute({
                signal: new AbortController().signal,
                callId: "tokens-web-search-integration",
                name: "web_search",
                arguments: { queries: ["one", "one", "two"] },
            });
            expect(result.isError).toBe(false);
            expect(started).toEqual(["one", "two"]);
            expect(result.value).toEqual({
                sources: [
                    { url: "https://results.test/one", title: "one", snippet: "one snippet" },
                    { url: "https://results.test/two", title: "two", snippet: "two snippet" },
                    { url: "https://results.test/shared", title: "shared", snippet: "shared snippet" },
                ],
                truncated: false,
            });
            expect(result.content.map((block) => block.type === "text" ? block.text : "").join(""))
                .toContain("https://results.test/two");
        }
        finally {
            await toolFiber.dispose();
            await providerFiber.dispose();
            vi.unstubAllGlobals();
        }
    });
});`;
const HOST_CONFIG_SOURCE = `import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outerRoot = path.resolve(process.env.TOKENS_OUTER_ROOT ?? "");
const harnessRoot = path.join(outerRoot, "desktop", "deepseek-harness");
const pluginRoot = process.env.TOKENS_WEB_SEARCH_ROOT;
const hostSpec = fileURLToPath(new URL("host-runtime.spec.mjs", import.meta.url)).replaceAll("\\\\", "/");
const { default: tsconfigPaths } = await import(pathToFileURL(path.join(
  harnessRoot,
  "node_modules",
  "vite-tsconfig-paths",
  "dist",
  "index.js",
)));
const { standardDecoratorPlugin } = await import(pathToFileURL(path.join(harnessRoot, "vitest.shared.ts")));

export default {
  root: harnessRoot,
  cacheDir: fileURLToPath(new URL(".vite-cache", import.meta.url)),
  plugins: [
    tsconfigPaths({ projects: [path.join(harnessRoot, "tsconfig.base.json")] }),
    standardDecoratorPlugin(),
  ],
  resolve: {
    alias: {
      "@tokens-web-search/plugin": path.join(pluginRoot, "lib", "index.js"),
      "@deepseek-ai/cordis": path.join(harnessRoot, "vendor", "cordis", "src", "index.ts"),
      "@deepseek-ai/schemastery": path.join(harnessRoot, "vendor", "schemastery", "src", "index.ts"),
      "@deepseek-ai/dsh-settings": fileURLToPath(new URL("host-settings-compat.mjs", import.meta.url)),
      "@tokens-host/dsh-settings": path.join(harnessRoot, "packages", "settings", "settings", "src", "index.ts"),
      "@deepseek-ai/dsh-system-prompt": path.join(harnessRoot, "packages", "core", "system-prompt", "src", "index.ts"),
      "@deepseek-ai/dsh-tools": path.join(harnessRoot, "packages", "core", "tools", "src", "index.ts"),
      "@deepseek-ai/dsh-web": path.join(harnessRoot, "packages", "web", "web", "src", "index.ts"),
      "@deepseek-ai/dsh-tool-web": path.join(harnessRoot, "packages", "web", "tool-web", "src", "index.ts"),
      "@tokens-host/command-ui": path.join(harnessRoot, "packages", "client", "ui-commands", "src", "client", "service.ts"),
      "@tokens-host/locale": path.join(harnessRoot, "packages", "client", "locale", "src", "client", "index.ts"),
    },
  },
  test: {
    include: [hostSpec],
    environment: "node",
    pool: "forks",
    testTimeout: 30_000,
  },
};`;
const HOST_SETTINGS_SOURCE = `export * from "@tokens-host/dsh-settings";
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
export function settingsNamespace(value) {
    if (!NAMESPACE_PATTERN.test(value)) {
        throw new TypeError(\`settings namespace "\${value}" must match \${String(NAMESPACE_PATTERN)}\`);
    }
    return value;
}
export function installSettingsSection(ctx, ns, schema, entry, hooks) {
    ctx.inject(["settings"], (settingsCtx) => {
        settingsCtx.settings.installSection(ctx, ns, schema, entry, hooks);
    });
}`;

// Each suite gets its own Node process to isolate fetch mocks and lifecycle hooks.
const testSuites = {
  "client-command": registerClientCommandTests,
  "config-contract": registerConfigContractTests,
  "engine-adapters": registerEngineAdaptersTests,
  "fetch-cancel": registerFetchCancelTests,
  "hedged-race": registerHedgedRaceTests,
  "host-integration": registerHostIntegrationTests,
  "package-contract": registerPackageContractTests,
  "platform-adapters": registerPlatformAdaptersTests,
  "plugin-runtime": registerPluginRuntimeTests,
  "time-range": registerTimeRangeTests,
  "validate-release": registerValidateReleaseTests,
};
const worker = process.env.TOKENS_WEB_SEARCH_TEST_SUITE;
if (worker) {
  if (!Object.hasOwn(testSuites, worker)) throw new Error("unknown test suite: " + worker);
  await testSuites[worker]();
} else {
  await executeCases();
}

async function executeCases() {
const standalone = process.argv.includes("--standalone");
const csvPath = path.join(root, "test", "test_cases.csv");
const outerRootIndex = process.argv.indexOf("--outer-root");
if (outerRootIndex >= 0) {
  const value = process.argv[outerRootIndex + 1];
  if (!value || value.startsWith("--")) {
    console.error("INCOMPLETE\tCSV\t--outer-root requires a path");
    process.exit(1);
  }
  process.env.TOKENS_OUTER_ROOT = path.resolve(value);
}
const hostNodeIndex = process.argv.indexOf("--host-node");
if (hostNodeIndex >= 0) {
  const value = process.argv[hostNodeIndex + 1];
  if (!value || value.startsWith("--")) {
    console.error("INCOMPLETE\tCSV\t--host-node requires a path");
    process.exit(1);
  }
  process.env.TOKENS_HOST_NODE = path.resolve(value);
}
const columns = [
  "用例编号", "所属模块", "用例标题", "前置条件", "测试数据",
  "操作步骤", "预期结果", "优先级", "自动化状态", "对应测试",
];
const allowedStatuses = new Set(["已自动化", "部分自动化", "待自动化", "人工验收"]);

function parseCsv(input) {
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function decodeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(source, name) {
  const match = source.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : undefined;
}

function normalizeTestPath(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function parseJunit(xml, fallbackFile) {
  const results = new Map();
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const name = attribute(match[1], "name");
    const file = attribute(match[1], "file") ?? fallbackFile;
    if (!name || !file) continue;
    const body = match[2] ?? "";
    let status = "passed";
    let reason = "";
    if (/<failure\b|<error\b/.test(body)) {
      status = "failed";
      reason = decodeXml(body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 500);
    } else if (/<skipped\b/.test(body)) {
      status = "incomplete";
      reason = "mapped test was skipped";
    }
    results.set(`${normalizeTestPath(file)} :: ${name}`, { status, reason });
  }
  return results;
}

function fail(message) {
  console.error(`INCOMPLETE\tCSV\t${message}`);
  process.exitCode = 1;
}

const parsed = parseCsv(await readFile(csvPath, "utf8"));
if (parsed.length === 0 || parsed[0].length !== columns.length || !columns.every((name, index) => parsed[0][index] === name)) {
  fail(`expected exact ${columns.length}-column header`);
  process.exit();
}

const cases = [];
const ids = new Set();
for (const [index, values] of parsed.slice(1).entries()) {
  const line = index + 2;
  if (values.length !== columns.length) {
    fail(`row ${line} has ${values.length} columns, expected ${columns.length}`);
    continue;
  }
  const entry = Object.fromEntries(columns.map((column, columnIndex) => [column, values[columnIndex]]));
  if (!entry.用例编号 || ids.has(entry.用例编号)) {
    fail(`row ${line} has a missing or duplicate case ID: ${entry.用例编号}`);
    continue;
  }
  ids.add(entry.用例编号);
  if (!allowedStatuses.has(entry.自动化状态)) {
    fail(`${entry.用例编号} has invalid automation status: ${entry.自动化状态}`);
  }
  cases.push(entry);
}
if (process.exitCode) process.exit();

const suiteNames = Object.keys(testSuites).filter((suite) => !standalone || suite !== "host-integration");
const runnerPath = fileURLToPath(import.meta.url);
const testResults = new Map();
const executionIssues = [];
for (const suite of suiteNames) {
  const file = runnerPath;
  const execution = spawnSync(process.execPath, ["--test", "--test-reporter=junit", file], {
    cwd: root,
    env: { ...process.env, TOKENS_WEB_SEARCH_TEST_SUITE: suite },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  for (const [key, value] of parseJunit(execution.stdout ?? "", file)) {
    if (testResults.has(key)) throw new Error("duplicate test name: " + key);
    testResults.set(key, value);
  }
  if (execution.error) {
    executionIssues.push(execution.error.message);
  } else if (execution.status !== 0) {
    executionIssues.push(`${suite} exited ${execution.status}: ${(execution.stderr ?? "").trim().slice(0, 300)}`);
  }
}
const failures = [];
const deferredCases = [];
const hostMapping = "test/run-test-cases.mjs :: real host tool-web executes this plugin provider end to end";

for (const entry of cases) {
  const mappings = entry.对应测试.split(/\r?\n| \| /).map((value) => value.trim()).filter(Boolean);
  if (standalone && mappings.includes(hostMapping)) {
    deferredCases.push(entry.用例编号);
    continue;
  }
  if (entry.自动化状态 !== "已自动化") {
    failures.push({ id: entry.用例编号, status: "INCOMPLETE", reason: `automation status is ${entry.自动化状态}` });
    continue;
  }
  if (mappings.length === 0) {
    failures.push({ id: entry.用例编号, status: "INCOMPLETE", reason: "no mapped test" });
    continue;
  }
  const mappedResults = mappings.map((mapping) => ({ mapping, result: testResults.get(mapping) }));
  const missing = mappedResults.find(({ result }) => result === undefined);
  if (missing) {
    failures.push({ id: entry.用例编号, status: "INCOMPLETE", reason: `mapped test not found: ${missing.mapping}` });
    continue;
  }
  const failed = mappedResults.find(({ result }) => result.status !== "passed");
  if (failed) {
    failures.push({
      id: entry.用例编号,
      status: failed.result.status === "failed" ? "FAIL" : "INCOMPLETE",
      reason: `${failed.mapping}: ${failed.result.reason || failed.result.status}`,
    });
  }
}

for (const issue of executionIssues) {
  failures.push({ id: "TEST-RUNNER", status: "INCOMPLETE", reason: issue });
}

if (failures.length === 0) {
  if (standalone) {
    for (const id of deferredCases) console.log(`INCOMPLETE\t${id}\tnot executed in standalone mode; use --outer-root for full host verification`);
    console.log(`${cases.length - deferredCases.length} standalone cases passed; ${deferredCases.length} host cases not executed.`);
  } else {
    console.log(`All ${cases.length} cases passed.`);
  }
} else {
  for (const failure of failures) {
    console.error(`${failure.status}\t${failure.id}\t${failure.reason}`);
  }
  process.exitCode = 1;
}
}
async function registerClientCommandTests() {
const { strict: assert } = await import("node:assert");
const { readFile } = await import("node:fs/promises");
const { default: test } = await import("node:test");
const { default: vm } = await import("node:vm");

async function loadClient(fetchImpl) {
  let registration;
  const context = vm.createContext({
    console,
    fetch: fetchImpl,
    URL,
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value;
        },
      },
    },
  });
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "lib/client.js" });
  assert.equal(registration.id, "tokens-dsh-web-search");
  const plugin = registration.factory((id) => { throw new Error(`unexpected client dependency: ${id}`); });
  return plugin;
}

test("client command registers ten engines, marks current selection, and mutates provider", async () => {
  const requests = [];
  const plugin = await loadClient(async (url, init) => {
    requests.push({ url, init });
    if (String(url).endsWith("/describe")) {
      return {
        async json() {
          return {
            ok: true,
            value: {
              namespaces: [{ ns: "free-search", value: { provider: "ddg", lang: "zh" } }],
            },
          };
        },
      };
    }
    return { async json() { return { ok: true }; } };
  });

  let command;
  let disposed = false;
  let disposeEffect;
  const commandUi = {
    register(value) {
      command = value;
      return () => { disposed = true; };
    },
  };
  const ctx = {
    inject(names, callback) {
      assert.deepEqual([...names], ["commandUi"]);
      callback({
        get: (name) => name === "commandUi" ? commandUi : undefined,
        effect(setup) {
          disposeEffect = setup();
        },
      });
    },
  };
  plugin.apply(ctx);
  assert.equal(command.name, "tokens-dsh-web-search");
  assert.equal(typeof command.description, "function");
  assert.equal(command.ui.kind, "popupSelect");
  const options = await command.ui.options();
  assert.equal(options.length, 10);
  assert.equal(options.find((option) => option.id === "ddg").active, true);
  assert.deepEqual(Array.from(options, (option) => option.id), [
    "ddg", "ddg-lite", "bing", "anysearch", "searxng",
    "exa", "tavily", "keenable", "perplexity", "deepseek-official",
  ]);

  await command.ui.onSelect({ id: "tavily" });
  const mutation = JSON.parse(requests.at(-1).init.body);
  assert.deepEqual(mutation, {
    ns: "free-search",
    ops: [{ op: "set", path: ["provider"], value: "tavily" }],
  });
  disposeEffect();
  assert.equal(disposed, true);
});

test("client command skips registration when commandUi is unavailable", async () => {
  const plugin = await loadClient(async () => { throw new Error("fetch must not run"); });
  let injected = false;
  plugin.apply({
    inject() {
      injected = true;
    },
  });
  assert.equal(injected, true);
});

async function mountClient(fetchImpl, locale) {
  const plugin = await loadClient(fetchImpl);
  const disposers = [];
  let command;
  plugin.apply({
    inject(_names, callback) {
      callback({
        get(name) {
          if (name === "locale") return locale;
          if (name === "commandUi") return { register(value) {
            command = value;
            return () => { command = undefined; };
          } };
        },
        effect(setup) { disposers.push(setup()); },
      });
    },
  });
  return { command, dispose: () => disposers.reverse().forEach((dispose) => dispose()) };
}

const describeResponse = (lang = "en") => ({ async json() {
  return { ok: true, value: { namespaces: [{ ns: "free-search", value: { provider: "bing", lang } }] } };
} });

test("client command localizes fallback labels and follows host locale changes with disposal", async () => {
  let language = "en";
  let dictionaries;
  let removed = false;
  const locale = {
    register(ns, values) {
      assert.equal(ns, "tokens-dsh-web-search");
      dictionaries = values;
      return () => { removed = true; };
    },
    bind() { return (key) => dictionaries[language][key]; },
  };
  const mounted = await mountClient(async () => describeResponse("zh"), locale);
  assert.equal(mounted.command.description(), "Switch web search engine");
  const en = await mounted.command.ui.options();
  assert.equal(en.find((option) => option.id === "bing").label, "Bing · Free");
  assert.equal(en.find((option) => option.id === "bing").detail, "Current");
  assert.equal(en.find((option) => option.id === "searxng").label, "SearXNG · Meta-search · Free");
  language = "zh";
  assert.equal(mounted.command.description(), "切换搜索引擎");
  const zh = await mounted.command.ui.options();
  assert.equal(zh.find((option) => option.id === "bing").label, "Bing · 免费");
  assert.equal(zh.find((option) => option.id === "bing").detail, "当前");
  mounted.dispose();
  assert.equal(removed, true);
  const fallback = await mountClient(async () => describeResponse("en"));
  assert.equal((await fallback.command.ui.options())[2].label, "Bing · Free");
  assert.equal(fallback.command.description(), "Switch web search engine");
  fallback.dispose();
});

test("client command rejects bridge errors with localized messages instead of false success", async () => {
  for (const lang of ["zh", "en"]) {
    let failing = false;
    const mounted = await mountClient(async () => failing
      ? { async json() { return { ok: false, message: "RAW SECRET 服务端错误" }; } }
      : describeResponse(lang));
    await mounted.command.ui.options();
    failing = true;
    await assert.rejects(mounted.command.ui.onSelect({ id: "bing" }), {
      message: lang === "en" ? "Failed to switch search engine" : "搜索引擎切换失败",
    });
    await assert.rejects(mounted.command.ui.options(), {
      message: lang === "en" ? "Search settings unavailable" : "搜索设置不可用",
    });
    mounted.dispose();
  }
});

test("client command forwards cancellation and rejects invalid engine without mutations", async () => {
  const requests = [];
  const mounted = await mountClient(async (url, init) => {
    requests.push({ url, init });
    return describeResponse();
  });
  const signal = new AbortController().signal;
  await mounted.command.ui.options({}, signal);
  assert.equal(requests[0].init.signal, signal);
  await assert.rejects(mounted.command.ui.options({}, AbortSignal.abort()));
  await assert.rejects(mounted.command.ui.onSelect({ id: "unknown" }), { message: "Invalid search engine" });
  assert.equal(requests.length, 1);
  mounted.dispose();
});
}

async function registerConfigContractTests() {
const { strict: assert } = await import("node:assert");
const { readFile } = await import("node:fs/promises");
const { default: test } = await import("node:test");

const { Config } = await import("../lib/index.js");

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
}

async function registerEngineAdaptersTests() {
const { strict: assert } = await import("node:assert");
const { afterEach, test } = await import("node:test");

const { searchAnysearch, searchBing, searchDeepSeekOfficial, searchDdgHtml, searchDdgLite, searchExa, searchExaMCP, searchKeenable, searchPerplexity, searchSearxng, searchTavily } = await import("../lib/index.js");

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
}

async function registerFetchCancelTests() {
// fetchHtml 取消语义的回归测试，走真实的 searchBing / searchDdgHtml 代码路径。
//
// 旧实现用 signal.addEventListener("abort", ...) 桥接外部取消。对一个"已经 abort 的
// signal"，规范规定 addEventListener 不会补发事件——于是取消之后发起的重试拿到一个全新的、
// 不受上游预算约束的 12 秒计时器。总预算不只是会被耗尽，是能被突破。
//
// 这些用例在连接建立前就已中止，不依赖网络可达性。
const { strict: assert } = await import("node:assert");
const { default: test } = await import("node:test");
const { searchBing, searchDdgHtml } = await import("../lib/index.js");

const engines = [
  ["searchBing", (signal) => searchBing("cancel probe", 3, {}, signal)],
  ["searchDdgHtml", (signal) => searchDdgHtml("cancel probe", 3, {}, signal)],
];

for (const [name, call] of engines) {
  test(`${name}: 已经 abort 的 signal 立即失败`, async () => {
    const started = Date.now();
    await assert.rejects(call(AbortSignal.abort()));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `应立即失败，实际 ${elapsed}ms`);
  });

  test(`${name}: 传入的超时 signal 会真正掐断请求`, async () => {
    const started = Date.now();
    await assert.rejects(call(AbortSignal.timeout(50)));
    const elapsed = Date.now() - started;
    // 旧实现里单次请求自带 12s 计时器，掐不断 -> 这里必须远小于 12s
    assert.ok(elapsed < 2000, `应在超时后立即失败，实际 ${elapsed}ms`);
  });
}
}

async function registerHedgedRaceTests() {
// 引擎竞速的回归测试。
//
// 背景：2026-09-16 用户报告搜索连续三次失败，每次恰好 30 秒。根因不是超时值太小，而是
// 串行回退——首选 Bing 的连接挂住后，插件对同一个地址重试 3 次（12s + 1.5s + 12s + 1.5s
// + 3s = 30.0s），把整条链的总预算全部烧光，排在后面的 9 个健康引擎一个请求都没发出去。
//
// 这些用例用假引擎跑，不碰网络。
const { strict: assert } = await import("node:assert");
const { default: http } = await import("node:http");
const { default: test } = await import("node:test");
const { hedgedRace } = await import("../lib/hedged-race.js");

const FAST = { hedgeMs: 60, staggerMs: 10 };
const never = () => new Promise(() => {});
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

test("取消前置竞速不调用任何引擎", async () => {
  let calls = 0;
  await assert.rejects(hedgedRace("bing", ["ddg"], ["tavily"], async () => {
    calls += 1;
    return { engine: "bing", result: { sources: ["unexpected"] } };
  }, { ...FAST, signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});

test("外部取消立即结束忽略signal的竞速且不补发或调用付费引擎", { timeout: 1500 }, async () => {
  const controller = new AbortController();
  const calls = [];
  let raceSignal;
  const pending = hedgedRace("bing", ["ddg"], ["tavily"], async (engine, signal) => {
    calls.push(engine);
    raceSignal = signal;
    return never();
  }, { hedgeMs: 200, staggerMs: 10, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
  await after(250);
  assert.deepEqual(calls, ["bing"]);
  assert.equal(raceSignal.aborted, true);
});

test("兜底引擎挂起时取消不再调用下一个付费引擎", { timeout: 1500 }, async () => {
  const controller = new AbortController();
  const calls = [];
  let paidStarted;
  const ready = new Promise((resolve) => { paidStarted = resolve; });
  const pending = hedgedRace("bing", [], ["tavily", "perplexity"], async (engine) => {
    calls.push(engine);
    if (engine === "bing") throw new Error("unavailable");
    paidStarted();
    return never();
  }, { ...FAST, signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending);
  assert.deepEqual(calls, ["bing", "tavily"]);
});

test("竞速胜出后错峰等待不会补发新请求", async () => {
  const calls = [];
  const won = await hedgedRace("bing", ["ddg", "anysearch"], [], async (engine) => {
    calls.push(engine);
    if (engine === "bing") throw new Error("unavailable");
    return { engine, result: { sources: ["win"] } };
  }, { hedgeMs: 100, staggerMs: 100 });
  assert.equal(won.engine, "ddg");
  await after(150);
  assert.deepEqual(calls, ["bing", "ddg"]);
});

// 造一个 runEngine：engines[name] 是返回 Promise 的函数，calls 记录调用顺序
function makeRunner(engines) {
  const calls = [];
  const runEngine = async (engine, raceSignal) => {
    calls.push(engine);
    const behavior = engines[engine];
    if (behavior === undefined) throw new Error(`no fake for ${engine}`);
    return { engine, result: await behavior(raceSignal) };
  };
  return { runEngine, calls };
}

test("首选在 hedge 窗口内返回时，全程只发一个请求", async () => {
  const { runEngine, calls } = makeRunner({
    bing: () => after(5, { sources: ["ok"] }),
    ddg: never,
  });
  const won = await hedgedRace("bing", ["ddg"], [], runEngine, FAST);
  assert.equal(won.engine, "bing");
  assert.deepEqual(calls, ["bing"], "补发不该被触发");
});

test("首选挂死时由竞速引擎秒级接管（旧实现在此处 30 秒报错）", async () => {
  const { runEngine, calls } = makeRunner({
    bing: never, // 连接挂住，永不返回——正是 2026-09-16 的故障形态
    ddg: () => after(20, { sources: ["from-ddg"] }),
    anysearch: never,
  });
  const started = Date.now();
  const won = await hedgedRace("bing", ["ddg", "anysearch"], [], runEngine, FAST);
  const elapsed = Date.now() - started;
  assert.equal(won.engine, "ddg");
  assert.deepEqual(won.result.sources, ["from-ddg"]);
  assert.ok(elapsed < 1000, `应在 1 秒内接管，实际 ${elapsed}ms`);
  assert.ok(calls.includes("bing") && calls.includes("ddg"), "补发应当发生");
});

test("胜出后落败与在途的请求被取消", async () => {
  let loserSignal;
  const { runEngine } = makeRunner({
    bing: never,
    ddg: () => after(20, { sources: ["win"] }),
    anysearch: (raceSignal) => {
      loserSignal = raceSignal;
      return never();
    },
  });
  await hedgedRace("bing", ["ddg", "anysearch"], [], runEngine, FAST);
  await after(30);
  assert.ok(loserSignal?.aborted, "落败引擎应收到 abort");
});

test("免费引擎全灭后才串行尝试兜底引擎", async () => {
  const { runEngine, calls } = makeRunner({
    bing: () => Promise.reject(new Error("boom")),
    ddg: () => Promise.reject(new Error("boom")),
    tavily: () => after(5, { sources: ["paid"] }),
  });
  const won = await hedgedRace("bing", ["ddg"], ["tavily"], runEngine, FAST);
  assert.equal(won.engine, "tavily");
  assert.equal(calls.indexOf("tavily"), 2, "兜底必须排在两个免费引擎之后");
});

test("全部失败返回 null（交由调用方组装带原因的错误）", async () => {
  const { runEngine } = makeRunner({
    bing: () => Promise.reject(new Error("boom")),
    ddg: () => Promise.reject(new Error("boom")),
  });
  assert.equal(await hedgedRace("bing", ["ddg"], [], runEngine, FAST), null);
});

test("首选比 hedge 窗口稍慢也不会被浪费", async () => {
  const { runEngine } = makeRunner({
    bing: () => after(120, { sources: ["slow-but-fine"] }),
    ddg: never,
  });
  const won = await hedgedRace("bing", ["ddg"], [], runEngine, FAST);
  assert.equal(won.engine, "bing", "leader 补发后仍应参与竞速");
});

test("没有补发引擎时，等首选跑完而不是立刻放弃", async () => {
  const { runEngine } = makeRunner({ bing: () => after(120, { sources: ["only"] }) });
  const won = await hedgedRace("bing", [], [], runEngine, FAST);
  assert.equal(won.engine, "bing");
});

// fetchHtml 的取消回归：旧实现用 signal.addEventListener("abort", ...)，
// 对一个"已经 abort 的 signal"不会触发，于是取消后发出的重试拿到一个全新的、
// 不受上游预算约束的 12 秒计时器——预算不只是被耗尽，是能被突破。
test("已 abort 的 signal 不会让请求继续跑（端到端）", async () => {
  const server = http.createServer(() => {}); // 永不响应
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const aborted = AbortSignal.abort();
    const started = Date.now();
    await assert.rejects(
      fetch(url, { signal: AbortSignal.any([aborted, AbortSignal.timeout(8000)]) }),
      "AbortSignal.any 必须让已 abort 的源立即生效"
    );
    assert.ok(Date.now() - started < 500, "不得等待新计时器");
  } finally {
    server.close();
  }
});
}

async function registerHostIntegrationTests() {
const { strict: assert } = await import("node:assert");
const { existsSync } = await import("node:fs");
const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { default: test } = await import("node:test");
const outerRoot = process.env.TOKENS_OUTER_ROOT ? path.resolve(process.env.TOKENS_OUTER_ROOT) : undefined;
const vitest = outerRoot ? path.join(outerRoot, "desktop", "deepseek-harness", "node_modules", "vitest", "vitest.mjs") : "";
const hostNode = process.env.TOKENS_HOST_NODE ? path.resolve(process.env.TOKENS_HOST_NODE) : process.execPath;
test("real host tool-web executes this plugin provider end to end", {
  skip: !outerRoot || !existsSync(vitest) ? "set TOKENS_OUTER_ROOT to a prepared TokensCowork checkout" : false,
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "tokens-web-search-integration-"));
  try {
    // Source-mode host integration needs files for Vite; these exist only for this run.
    const spec = path.join(directory, "host-runtime.spec.mjs");
    const config = path.join(directory, "host-vitest.config.mjs");
    await writeFile(spec, HOST_SPEC_SOURCE, "utf8");
    await writeFile(config, HOST_CONFIG_SOURCE, "utf8");
    await writeFile(path.join(directory, "host-settings-compat.mjs"), HOST_SETTINGS_SOURCE, "utf8");
    const result = spawnSync(hostNode, [vitest, "run", spec, "--config", config, "--reporter=dot"], {
      cwd: path.join(outerRoot, "desktop", "deepseek-harness"),
      env: { ...process.env, TOKENS_OUTER_ROOT: outerRoot, TOKENS_WEB_SEARCH_ROOT: root },
      encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 0, String(result.stdout) + "\n" + String(result.stderr));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
}

async function registerPackageContractTests() {
const { strict: assert } = await import("node:assert");
const { spawnSync } = await import("node:child_process");
const { mkdtemp, readFile, rm } = await import("node:fs/promises");
const { default: os } = await import("node:os");
const { default: path } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { default: test } = await import("node:test");

const root = new URL("../", import.meta.url);

test("运行时和 package.json 声明 Node.js 20.3 最低版本", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.engines.node, ">=20.3.0");
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

test("npm pack 实际产物包含完整入口且排除本地数据", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tokens-web-search-pack-"));
  try {
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm pack --json --ignore-scripts"]
      : ["pack", "--json", "--ignore-scripts"];
    const result = spawnSync(command, args, {
      cwd: fileURLToPath(root),
      env: { ...process.env, npm_config_pack_destination: directory },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const [packed] = JSON.parse(result.stdout);
    assert.equal(packed.name, "tokens-dsh-web-search");
    const archive = path.join(directory, packed.filename);
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    const files = listing.stdout.trim().split(/\r?\n/).map((entry) => entry.replace(/^package\//, ""));
    assert.deepEqual(new Set(files), new Set(packed.files.map((entry) => entry.path)));
    assert.deepEqual(new Set(files), new Set([
      "lib/index.js", "lib/client.js", "lib/hedged-race.js", "cordis.patch.yml", "package.json", "LICENSE", "README.md",
    ]));
    for (const entry of files) {
      assert.doesNotMatch(entry, /(?:^|\/)(?:test|tests|\.playwright-mcp|\.env|settings\.ya?ml)(?:\/|$)/i);
    }
    const manifest = spawnSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" });
    assert.equal(manifest.status, 0, manifest.stderr);
    const pkg = JSON.parse(manifest.stdout);
    assert.equal(pkg.main, "lib/index.js");
    assert.equal(pkg.dsh.bundle.patch, "cordis.patch.yml");
    for (const entry of [pkg.main, pkg.exports["./client"].replace(/^\.\//, ""), pkg.dsh.bundle.patch]) {
      assert.ok(files.includes(entry));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package identity private registry and bilingual marketplace metadata match this repository", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.name, "tokens-dsh-web-search");
  assert.equal(pkg.repository.url, "git+https://github.com/sobermh/tokens_DshWebSearch_code.git");
  assert.equal(pkg.publishConfig.registry, "https://npm.tokensapi.ai/");
  for (const field of ["displayName", "summary"]) {
    assert.ok(pkg.tokenscowork[field]["zh-CN"].trim());
    assert.ok(pkg.tokenscowork[field]["en-US"].trim());
    assert.notEqual(pkg.tokenscowork[field]["zh-CN"], pkg.tokenscowork[field]["en-US"]);
  }
});
}

async function registerPlatformAdaptersTests() {
const { strict: assert } = await import("node:assert");
const { afterEach, test } = await import("node:test");

const { searchBilibili, searchGithub, searchPlatform, searchReddit, searchV2ex } = await import("../lib/index.js");

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
}

async function registerPluginRuntimeTests() {
const { strict: assert } = await import("node:assert");
const { readFile } = await import("node:fs/promises");
const { Readable } = await import("node:stream");
const { default: test } = await import("node:test");

const { SettingsConflictError } = await import("@deepseek-ai/dsh-settings");
const { ALL_ENGINES, apply } = await import("../lib/index.js");

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
        watch: (callback) => {
          state.settingsChanged = callback;
          return () => { state.disposed += 1; };
        },
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
      state.settingsChanged?.();
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
  assert.match(host.prompts[0].text, /\/tokens-dsh-web-search/);
  assert.match(host.prompts[0].text, /API fallback engines are tried serially/);
  assert.match(host.prompts[0].text, /All engines can fail/);
  assert.doesNotMatch(host.prompts[0].text, /Settings > Plugins|Never tell the user search is unavailable/);
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

test("cache isolates source objects on both misses and hits", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(bingHtml(1, "isolation"));
  };
  const host = createHost();
  const first = await host.provider.search({ query: "isolation", maxResults: 1 });
  const original = { ...first.sources[0] };
  first.sources[0].url = "https://pollution.test/miss";
  const hit = await host.provider.search({ query: "isolation", maxResults: 1 });
  assert.deepEqual(hit.sources[0], original);
  hit.sources[0].title = "polluted hit";
  const next = await host.provider.search({ query: "isolation", maxResults: 1 });
  assert.deepEqual(next.sources[0], original);
  assert.equal(calls, 1);
});

test("settings changes invalidate cached and in-flight search results", async () => {
  const markets = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url) => {
    const market = new URL(url).searchParams.get("mkt");
    markets.push(market);
    if (markets.length === 2) await gate;
    return new Response(bingHtml(1, market));
  };
  const host = createHost();
  await host.provider.search({ query: "settings", maxResults: 1 });
  await host.settings.mutate("free-search", [{ op: "set", path: ["bingMarket"], value: "en-US" }]);
  const pending = host.provider.search({ query: "settings", maxResults: 1 });
  await host.settings.mutate("free-search", [{ op: "set", path: ["bingMarket"], value: "ja-JP" }]);
  release();
  await pending;
  const latest = await host.provider.search({ query: "settings", maxResults: 1 });
  assert.deepEqual(markets, ["zh-CN", "en-US", "ja-JP"]);
  assert.match(latest.sources[0].title, /ja-JP/);
});

test("fallback preserves the successful engine answer alongside its diagnostic note", async () => {
  globalThis.fetch = async (url) => String(url).includes("api.perplexity.ai")
    ? jsonResponse({ choices: [{ message: { content: "Verified answer from Perplexity" } }], citations: ["https://answer.test"] })
    : new Response("unavailable", { status: 503 });
  const host = createHost({ perplexityApiKey: "test-only", searxngInstances: ["https://searx.test"] });
  const result = await host.provider.search({ query: "answer", maxResults: 1 });
  assert.equal(result.provider, "perplexity");
  assert.match(result.content, /Verified answer from Perplexity/);
  assert.match(result.content, /Note: bing/);
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
}

async function registerTimeRangeTests() {
const { strict: assert } = await import("node:assert");
const { default: test } = await import("node:test");

const { approximateTimeRange, formatKeenableRelative, parseTimeRange } = await import("../lib/index.js");

test("固定时间范围映射为约定天数", () => {
  assert.deepEqual(parseTimeRange("day"), { days: 1 });
  assert.deepEqual(parseTimeRange("week"), { days: 7 });
  assert.deepEqual(parseTimeRange("month"), { days: 30 });
  assert.deepEqual(parseTimeRange("year"), { days: 365 });
});

test("相对时间和绝对日期被正确解析，无效值不产生时间范围", () => {
  assert.deepEqual(parseTimeRange("12h"), { days: 0.5 });
  assert.deepEqual(parseTimeRange("3d"), { days: 3 });
  assert.deepEqual(parseTimeRange("3w"), { days: 21 });
  assert.deepEqual(parseTimeRange("2mo"), { days: 60 });
  assert.deepEqual(parseTimeRange("1.5y"), { days: 547.5 });
  assert.deepEqual(parseTimeRange("2026-07-01"), { after: "2026-07-01" });
  assert.equal(parseTimeRange("recent-ish"), undefined);
  assert.equal(parseTimeRange({ days: Number.NaN }), undefined);
});

test("固定档引擎选择最近时间档且 Keenable 使用相对格式", () => {
  assert.equal(approximateTimeRange(2), "day");
  assert.equal(approximateTimeRange(14), "week");
  assert.equal(approximateTimeRange(90), "month");
  assert.equal(approximateTimeRange(91), "year");
  assert.equal(formatKeenableRelative(0.5), "12h");
  assert.equal(formatKeenableRelative(7), "7d");
  assert.equal(formatKeenableRelative(60), "2mo");
  assert.equal(formatKeenableRelative(365), "1y");
});

test("时间范围拒绝零值溢出和不存在的日期", () => {
  for (const input of ["0h", "0d", "9".repeat(400) + "y", "2026-02-29", "2026-04-31", "2026-13-01", { after: "2026-02-30" }, { days: 0 }]) {
    assert.equal(parseTimeRange(input), undefined, JSON.stringify(input));
  }
  assert.deepEqual(parseTimeRange("2024-02-29"), { after: "2024-02-29" });
  assert.deepEqual(parseTimeRange({ after: "2024-02-29" }), { after: "2024-02-29" });
});
}

async function registerValidateReleaseTests() {
const { strict: assert } = await import("node:assert");
const { readFileSync } = await import("node:fs");
const { default: test } = await import("node:test");
const { validateRelease } = await import("../scripts/validate-release.mjs");
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const baseline = () => ({
  name: "tokens-dsh-web-search",
  version: "0.2.0",
  publishConfig: { registry: "https://npm.tokensapi.ai/" },
});

test("仓库当前的 package.json 自身必须能通过校验", () => {
  assert.equal(validateRelease(manifest, `v${manifest.version}`), manifest.version);
});
test("包名被改动时拒绝发布", () => {
  assert.throws(() => validateRelease({ ...baseline(), name: "tokens-dsh-web-search-fork" }, "v0.2.0"), /Unexpected release package name/);
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
  const m = { ...baseline(), publishConfig: { registry: "https://npm.tokensapi.ai/", access: "public" } };
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
}
