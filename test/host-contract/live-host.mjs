/**
 * Support layer for the real-host contract cases (HOST-005 … HOST-022).
 *
 * Everything here runs against ONE staged host: the `dsh-plugin-desktop`
 * directory of a product build (`.build/desktop`, `.build/desktop-v060`,
 * `.build/desktop-v0525`). `scripts/check-host-contracts.mjs` maps the gate's
 * single `DSH_HOST_ROOT` onto `TOKENS_HOST_ROOT` for this module.
 *
 * The host is never stubbed. `startLiveHost()` asks the host's own launcher to
 * boot a throwaway profile whose loader entries are the real services this
 * plugin talks to — settings, tools, web, web server, credentials, system
 * prompt, and upstream `tool-web` — and activates the plugin through the real
 * Loader. Only the outside world (DuckDuckGo, Bing, Tavily, GitHub …) is
 * scripted, because that is not a host interface.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HOST_ROOT_ENV = "TOKENS_HOST_ROOT";

/**
 * The real fetch, captured before any case swaps the global one. The fixture's
 * own loopback requests must never go through a case's scripted handler.
 */
const realFetch = globalThis.fetch;

/** The plugin's own repository root, i.e. the code under test. */
export const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The loader entry id the fixture gives the plugin; deliberately not `free-search`. */
export const ENTRY_ID = "tokens-web-search";

/** The namespace the plugin's bridge protocol exposes on every host generation. */
export const BRIDGE_NS = "free-search";

export function hostRoot() {
  const value = process.env[HOST_ROOT_ENV];
  return value ? path.resolve(value) : undefined;
}

/** Why the host cases cannot run, or false when they can. */
export function missingHost() {
  const root = hostRoot();
  if (!root) return `${HOST_ROOT_ENV} is not set (the gate passes DSH_HOST_ROOT)`;
  try {
    createRequire(path.join(root, "package.json")).resolve("@deepseek-ai/dsh-app-boot");
  } catch {
    return `staged host has no @deepseek-ai/dsh-app-boot: ${root}`;
  }
  return false;
}

/** Import one package from the staged host, by the name the plugin would use. */
export async function loadHostModule(specifier) {
  const resolved = createRequire(path.join(hostRoot(), "package.json")).resolve(specifier);
  return { resolved, module: await import(pathToFileURL(resolved).href) };
}

/** Import one package from the staged host, or undefined when it ships no such package. */
export async function loadOptionalHostModule(specifier) {
  try {
    return await loadHostModule(specifier);
  } catch {
    return undefined;
  }
}

let facts;

/**
 * What this host generation actually provides, probed rather than inferred from
 * a version string. Every case that behaves differently across generations
 * branches on one of these flags and says so in its report.
 */
export async function hostFacts() {
  if (facts !== undefined) return facts;
  const root = hostRoot();
  const appBoot = await loadHostModule("@deepseek-ai/dsh-app-boot");
  const settings = await loadHostModule("@deepseek-ai/dsh-settings");
  const schemastery = await loadHostModule("@deepseek-ai/schemastery");
  const runtime = createRequire(path.join(root, "package.json"))("@deepseek-ai/dsh/package.json");
  facts = {
    root,
    runtimeVersion: runtime.version,
    // DSH 0.1 publishes the two section helpers (Desktop's own patch adds them)
    // and the plugin installs an explicit settings section. DSH 0.2 dropped
    // them and derives the form from a volatile Config instead.
    legacySettings: typeof settings.module.installSettingsSection === "function",
    // The concrete settings service differs with it: 0.1 ships an abstract
    // provider plus a file-backed subclass, 0.2 ships one service.
    settingsEntry: typeof settings.module.installSettingsSection === "function"
      ? "cordis:settings-file"
      : "cordis:settings",
    hasConfigEditor: (await loadOptionalHostModule("@deepseek-ai/dsh-config-editor")) !== undefined,
    hasReadProfilePatches: typeof appBoot.module.readProfilePatches === "function",
    hasCompatibilityEvaluator: typeof appBoot.module.evaluatePluginCompatibility === "function",
    hasVolatileSchema: typeof schemastery.module.default.object({}).volatile === "function",
  };
  return facts;
}

/** Import the plugin under test, by absolute path, from this work tree. */
export async function loadPluginUnderTest() {
  const entry = path.join(pluginRoot, "lib", "index.js");
  return { entry, module: await import(pathToFileURL(entry).href) };
}

/** The `@deepseek-ai/*` specifiers the plugin's shipped files really import. */
export async function pluginHostImports() {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
  const found = new Set();
  for (const file of manifest.files.filter((entry) => entry.endsWith(".js"))) {
    const text = await readFile(path.join(pluginRoot, file), "utf8");
    for (const match of text.matchAll(/from\s+"(@deepseek-ai\/[^"]+)"/g)) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Boot a throwaway profile on the staged host with the real services this plugin
 * uses, and let the real Loader activate the plugin.
 *
 * @param options.plugin - plugin module to activate (defaults to the one under test).
 * @param options.config - the plugin's loader entry config.
 * @param options.omit - service entry ids to leave out, for reverse controls.
 * @param options.webConfig - config for the real `web` seam (provider selection).
 * @returns the booted context plus the fixture's own handles.
 */
export async function startLiveHost(options = {}) {
  const host = await hostFacts();
  const appBoot = (await loadHostModule("@deepseek-ai/dsh-app-boot")).module;
  const omit = new Set(options.omit ?? []);
  const plugin = options.plugin ?? (await loadPluginUnderTest()).module;

  const builtins = {
    "web-search": plugin,
    "system-prompt": (await loadHostModule("@deepseek-ai/dsh-system-prompt")).module.default,
    tools: (await loadHostModule("@deepseek-ai/dsh-tools")).module.default,
    web: (await loadHostModule("@deepseek-ai/dsh-web")).module.default,
    "web-server": (await loadHostModule("@deepseek-ai/dsh-host-webserver")).module.default,
    "credentials-local": (await loadHostModule("@deepseek-ai/dsh-credentials-local")).module.default,
    "tool-web": (await loadHostModule("@deepseek-ai/dsh-tool-web")).module,
  };
  if (host.legacySettings) {
    builtins["settings-file"] = (await loadHostModule("@deepseek-ai/dsh-settings-file")).module.default;
  } else {
    builtins.settings = (await loadHostModule("@deepseek-ai/dsh-settings")).module.default;
    builtins.editor = (await loadHostModule("@deepseek-ai/dsh-config-editor")).module.default;
  }

  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "tokens-web-search-host-")));
  const dir = path.join(home, "profiles", "test");
  appBoot.initProfile(dir, ["test-bundle"]);
  const bundleDir = path.join(dir, "node_modules", "test-bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: "tokens-web-search-host-fixture" }));
  writeFileSync(path.join(bundleDir, "package.json"), JSON.stringify({
    name: "test-bundle",
    version: "1.0.0",
    dsh: { bundle: { patch: "cordis.patch.yml" } },
  }));

  const settingsDocument = path.join(dir, "settings.yaml");
  const credentialsDocument = path.join(home, "credentials.yaml");
  const entries = [];
  const add = (id, name, config) => {
    if (omit.has(id)) return;
    entries.push(config === undefined ? { id, name } : { id, name, config });
  };
  if (host.legacySettings) {
    writeFileSync(settingsDocument, "");
    // `path`, not `filename`: the key name matters, because settings-file falls
    // back to resolveDshHome()/settings.yaml when it is absent -- i.e. the real
    // user's document. `dshHome` pins that fallback inside the fixture too, and
    // the assertion after boot refuses to run if either is ignored.
    add("settings", "cordis:settings-file", { path: settingsDocument, dshHome: home, watch: false });
  } else {
    add("config-editor", "cordis:editor");
    add("settings", "cordis:settings");
  }
  add("system-prompt", "cordis:system-prompt");
  add("tools", "cordis:tools");
  add("web", "cordis:web", { searchProvider: "ddg", ...(options.webConfig ?? {}) });
  add("web-server", "cordis:web-server", { host: "127.0.0.1", port: 0 });
  add("credentials", "cordis:credentials-local", { path: credentialsDocument, dshHome: home, watch: false });
  add(ENTRY_ID, "cordis:web-search", {
    provider: "bing",
    cache: false,
    cacheTtl: 0,
    platforms: [],
    ...(options.config ?? {}),
  });
  add("tool-web", "cordis:tool-web", {
    fetch: false,
    search: true,
    searchMaxResults: 5,
    searchMaxQueries: 4,
    searchTimeoutMs: 60_000,
  });
  writeFileSync(path.join(bundleDir, "cordis.patch.yml"), JSON.stringify([{ insert: entries }]));
  const configPath = path.join(dir, "cordis.yml");
  writeFileSync(configPath, "[]");

  let profile;
  let patches;
  if (host.hasReadProfilePatches) {
    profile = {
      name: "test",
      startedBundles: ["test-bundle"],
      dir,
      patchPath: path.join(dir, "cordis.patch.yml"),
      installAnchor: path.join(home, "package.json"),
      cwd: home,
      home,
      overlays: [],
      telemetryDisabledEnv: undefined,
    };
    patches = appBoot.readProfilePatches("test", profile);
  } else {
    // DSH 0.1 has no readProfilePatches; its launcher loads the profile
    // directory and composes the layers it finds there.
    const loaded = appBoot.loadProfileDirectory("test", dir, path.join(home, "package.json"));
    profile = { ...loaded, home, cwd: home, installAnchor: path.join(home, "package.json") };
    patches = loaded.layers.flatMap((layer) => layer.patches ?? layer);
  }

  let ctx;
  try {
    ctx = await appBoot.boot("test", configPath, patches, (bootCtx) => {
      bootCtx.provide("profileContext", profile);
      bootCtx.provide("appReady", { onReady: (listener) => { listener(); return () => {}; } });
      Object.assign(bootCtx.loader.builtins, builtins);
    });
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }

  // Refuse to run against anything outside the throwaway home. These services
  // write real documents: a config key the host stopped reading would silently
  // point them at the developer's own $DSH_HOME and the cases would both corrupt
  // it and leak state into each other.
  for (const [label, document] of [
    ["settings", typeof ctx.settings?.documentPath === "string" ? ctx.settings.documentPath : undefined],
    ["credentials", typeof ctx.credentials?.documentPath === "string" ? ctx.credentials.documentPath : undefined],
  ]) {
    if (document === undefined) continue;
    if (path.relative(home, path.resolve(document)).startsWith("..")) {
      await ctx.fiber.dispose();
      rmSync(home, { recursive: true, force: true });
      throw new Error(`${label} document escaped the fixture home: ${document} (expected under ${home})`);
    }
  }

  // Only DSH 0.2 publishes an entry list (the config editor). Nothing else needs
  // it: every other case observes activation through the plugin's own effects on
  // the real services, which works on both generations.
  const entryFiber = (id = ENTRY_ID) =>
    typeof ctx.configEditor?.entries === "function"
      ? ctx.configEditor.entries().find((row) => row.options.id === id)?.fiber
      : undefined;

  const origin = () => {
    const server = ctx.get("webServer");
    if (server === undefined) return undefined;
    // getOrigin() only exists from DSH 0.2.1; older hosts expose host/port.
    if (typeof server.getOrigin === "function") {
      const value = server.getOrigin();
      return value.startsWith("http") ? value : `http://${value}`;
    }
    return `http://${server.host}:${server.port}`;
  };

  return {
    ctx,
    host,
    profile,
    home,
    settingsDocument,
    credentialsDocument,
    patchPath: path.join(dir, "cordis.patch.yml"),
    entryFiber,
    origin,
    pluginSettings: (options = { redactSecrets: true }) =>
      ctx.settings.describe(options).find((row) => String(row.ns) === (host.legacySettings ? BRIDGE_NS : ENTRY_ID)),
    async dispose() {
      try {
        await ctx.fiber.dispose();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

/** Run `body` with `globalThis.fetch` replaced; the outside world is not a host interface. */
export async function withFetch(handler, body) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input.url ?? input);
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** A Bing result page large enough to clear the plugin's empty-shell guard. */
export function bingHtml(query, count = 2) {
  const rows = Array.from({ length: count }, (_, index) =>
    `<li class="b_algo"><h2><a href="https://results.test/${encodeURIComponent(query)}/${index}">${query} ${index}</a></h2>`
    + `<p>${query} snippet ${index}</p></li>`);
  return "x".repeat(600) + rows.join("");
}

/**
 * One raw HTTP request at a real origin, with the headers exactly as given.
 *
 * `fetch` refuses to set `Host`, which is the header the bridge's loopback fence
 * reads first, so the fence cases cannot be written with it: every forged
 * request would arrive looking honest and pass.
 */
export async function rawRequest(origin, { method = "POST", path: requestPath, headers = {}, body }) {
  const http = await import("node:http");
  const target = new URL(requestPath, origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: { "content-type": "application/json", ...headers },
      setHost: !Object.keys(headers).some((name) => name.toLowerCase() === "host"),
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({ status: response.statusCode, body: parsed, text });
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

/** POST JSON at a real origin, the way the plugin's own client does. */
export async function postJson(origin, requestPath, body, headers = {}) {
  const response = await realFetch(`${origin}${requestPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}
