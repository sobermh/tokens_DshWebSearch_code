/**
 * Real-host contract cases for tokens-dsh-web-search (HOST-005 … HOST-022).
 *
 * One case per group of host interfaces the plugin actually uses; every one of
 * them is called for real against the staged host named by `DSH_HOST_ROOT`.
 * `docs/host-interfaces.md` is the interface ↔ case table.
 *
 * House rules these cases follow (T0047 A″):
 *  - assert only what the plugin reads or calls. A host that adds a field, an
 *    event, a settings namespace, a tool or an endpoint stays compatible.
 *  - validate shapes with the host's own schema, descriptor or codec rather
 *    than a hand-written expected object.
 *  - every case names the plugin behaviour it protects, so a red case says
 *    whether the plugin or the host moved.
 *  - a reverse control must exercise the same path the case asserts, and it
 *    must use a value the host cannot produce by falling back to a default.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  BRIDGE_NS,
  ENTRY_ID,
  bingHtml,
  hostFacts,
  loadHostModule,
  loadPluginUnderTest,
  pluginHostImports,
  pluginRoot,
  postJson,
  rawRequest,
  startLiveHost,
  withFetch,
} from "./live-host.mjs";

/**
 * Every runtime this plugin's dsh peer ranges claim, oldest first. The upper
 * bound only guards the next major, so a 0.x minor the product has not shipped
 * yet is claimed on purpose: version numbers cannot predict compatibility, and
 * what actually guards an upgrade is the host contract gate below.
 */
const CLAIMED_RUNTIMES = ["0.1.5-rc.2", "0.2.0-rc.2", "0.2.1-rc.2", "0.3.0-rc.1"];
/**
 * The first runtime the upper bound has to refuse. A prerelease sorts before
 * its release, so an upper bound written without `-0` would let this one in.
 */
const REFUSED_RUNTIME = "1.0.0-rc.1";

const manifest = () => JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8"));

const dshPeers = (pkg) => Object.entries(pkg.peerDependencies ?? {})
  .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"));

/**
 * The unmet requirements of a compatibility verdict. DSH 0.2.0 calls the field
 * `peers`, 0.2.1 renamed it `requirements`; a reader that knows one name reads
 * "blocked" as "clean" on the other host.
 */
const unmet = (issue) => issue?.requirements ?? issue?.peers;

/** A scripted outside world: Bing answers, everything else refuses. */
const bingOnly = (url) => {
  if (url.startsWith("https://www.bing.com/search")) {
    const query = new URL(url).searchParams.get("q") ?? "";
    return new Response(bingHtml(query));
  }
  return new Response("blocked", { status: 503 });
};

/** Validate a value with the host's own validator against a host-published schema. */
async function validateWithHost(schema, value) {
  const tools = (await loadHostModule("@deepseek-ai/dsh-tools")).module;
  tools.assertSupportedJsonSchema(schema);
  return tools.validateJsonSchemaValue(schema, value);
}

async function execute(ctx, name, args) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `host-contract-${name}`,
    name,
    arguments: args,
  });
}

/** The section the plugin contributes to the real prompt assembly, as the host assembled it. */
async function promptSection(ctx) {
  const assembly = await ctx.systemPrompt.assemble();
  return assembly.sections.find((section) => section.name === "free-search:engines");
}

export const HOST_CONTRACT_CASES = [
  {
    id: "HOST-005",
    title: "the code under test is this work tree while every dsh import is the host's",
    depends:
      "A staged host keeps node_modules/tokens-dsh-web-search as a junction to its own pinned copy. "
      + "If the suite resolved that, it would be green about code nobody is about to ship.",
    async run() {
      const host = await hostFacts();
      const { entry } = await loadPluginUnderTest();
      const inside = (parent, child) => !path.relative(parent, child).startsWith("..");

      assert.ok(inside(pluginRoot, entry), `plugin entry is outside the work tree: ${entry}`);
      assert.ok(!inside(host.root, entry), `plugin entry resolved inside the host: ${entry}`);

      // The host's own pinned copy, when it has one, must be a different path.
      const hostRequire = createRequire(path.join(host.root, "package.json"));
      let pinned;
      try {
        pinned = hostRequire.resolve("tokens-dsh-web-search");
      } catch {
        pinned = undefined;
      }
      if (pinned !== undefined) {
        assert.notEqual(path.resolve(pinned), path.resolve(entry));
      }

      // Each @deepseek-ai package the shipped files import has to come from the
      // host, or the suite is measuring some other copy of the runtime.
      const imports = await pluginHostImports();
      assert.ok(imports.length > 0, "the plugin imports no @deepseek-ai package at all");
      for (const specifier of imports) {
        const { resolved } = await loadHostModule(specifier);
        assert.ok(inside(host.root, resolved), `${specifier} resolved outside the host: ${resolved}`);
      }
    },
  },

  {
    id: "HOST-006",
    title: "the dsh packages the plugin imports export what it reads on this host",
    depends:
      "lib/index.js picks its settings generation from the exports of @deepseek-ai/dsh-settings, "
      + "not from a version number, and needs Schema.volatile only on the generation that derives forms.",
    async run() {
      const host = await hostFacts();
      const settings = (await loadHostModule("@deepseek-ai/dsh-settings")).module;
      const tools = (await loadHostModule("@deepseek-ai/dsh-tools")).module;
      const schemastery = (await loadHostModule("@deepseek-ai/schemastery")).module.default;
      const plugin = (await loadPluginUnderTest()).module;

      // Read unconditionally by the bridge's conflict mapping.
      assert.equal(typeof settings.SettingsConflictError, "function");
      assert.equal(typeof tools.defineTool, "function");

      // The two helpers travel together; half of them is a host the plugin's
      // branch selection cannot describe.
      assert.equal(typeof settings.installSettingsSection === "function", host.legacySettings);
      assert.equal(typeof settings.settingsNamespace === "function", host.legacySettings);
      assert.equal(typeof settings.default.prototype.installSection === "function", host.legacySettings);

      // Schema.volatile is required exactly on the generation that derives the
      // settings form from the Config; lib/index.js throws rather than silently
      // shipping a form nobody can write to.
      assert.equal(typeof schemastery.object({}).volatile === "function", !host.legacySettings);
      const json = plugin.Config.toJSON();
      assert.equal(Boolean(json.refs[String(json.uid)].meta.volatile), !host.legacySettings);

      // The bridge protocol keeps one namespace across both generations.
      assert.equal(plugin.FREE_SEARCH_NS, BRIDGE_NS);
    },
  },

  {
    id: "HOST-007",
    title: "the real Loader activates the plugin and honours its inject list",
    depends:
      "lib/index.js exports inject = ['web'] and registers everything from apply(ctx, config). "
      + "If the host stopped honouring inject, apply would run without ctx.web and throw at startup.",
    async run() {
      const started = await startLiveHost();
      try {
        // Activated: the plugin's effects are on the real services.
        const names = started.ctx.tools.schemas().map((schema) => schema.name);
        for (const tool of ["free_search_test", "platform_search", "advanced_search"]) {
          assert.ok(names.includes(tool), `${tool} was not registered on the real tool runtime`);
        }
        assert.ok(await promptSection(started.ctx), "no prompt section on the real system prompt service");
        const described = await postJson(started.origin(), "/api/tokens-dsh-web-search-settings/describe", {});
        assert.equal(described.status, 200);

        const fiber = started.entryFiber();
        if (fiber !== undefined) {
          // Where the host publishes an entry list, the plugin's entry and the
          // settings entry must be in the same state: both activated.
          assert.equal(fiber.state, started.entryFiber("settings").state);
        }
      } finally {
        await started.dispose();
      }

      // Reverse control on the same path: without `web` the plugin must not
      // run. A host that ignored inject would call apply() anyway and blow up
      // inside the plugin on ctx.web.registerSearchProvider.
      //
      // How the host says so is its own business and it differs by generation:
      // DSH 0.1 refuses to finish booting a profile with a pending entry, DSH
      // 0.2 warns and carries on. Both are "the plugin did not run", which is
      // the whole contract, so either is accepted -- and nothing else is.
      let gated;
      try {
        gated = await startLiveHost({ omit: ["web", "tool-web"] });
      } catch (error) {
        assert.match(String(error?.message), /activate|pending/i, String(error?.stack));
      }
      if (gated !== undefined) {
        try {
          const names = gated.ctx.tools.schemas().map((schema) => schema.name);
          assert.equal(names.includes("advanced_search"), false, "the plugin ran without its injected web service");
          assert.equal(await promptSection(gated.ctx), undefined);
        } finally {
          await gated.dispose();
        }
      }
    },
  },

  {
    id: "HOST-008",
    title: "the real web seam selects this plugin's provider by id and enforces maxResults",
    depends:
      "The plugin registers one provider with id 'ddg' through ctx.web.registerSearchProvider and "
      + "relies on the seam to select it by the configured id and to cap sources to maxResults.",
    async run() {
      const started = await startLiveHost();
      try {
        const result = await withFetch(bingOnly, () =>
          started.ctx.web.search({ query: "seam", maxResults: 1 }));
        // The vocabulary the seam's consumers read, and nothing more. The bound
        // is honoured end to end; whether the plugin or the seam did the cutting
        // is the seam's business, so `truncated` is only read, not pinned.
        assert.equal(Array.isArray(result.sources), true);
        assert.equal(result.sources.length, 1, "maxResults did not reach the provider");
        assert.equal(typeof result.truncated, "boolean");
        assert.equal(typeof result.sources[0].url, "string");
      } finally {
        await started.dispose();
      }

      // Reverse control: the configured id really decides. 'ddg' is the
      // plugin's own provider id, so a host that stopped matching ids would
      // keep working above and silently pick anything registered.
      const { module: web } = await loadHostModule("@deepseek-ai/dsh-web");
      const mismatched = await startLiveHost({ webConfig: { searchProvider: "not-this-plugin" } });
      try {
        await assert.rejects(
          () => mismatched.ctx.web.search({ query: "seam", maxResults: 1 }),
          (error) => error instanceof web.WebError,
        );
      } finally {
        await mismatched.dispose();
      }
    },
  },

  {
    id: "HOST-009",
    title: "upstream tool-web runs web_search through this plugin and the host validates the value",
    depends:
      "cordis.patch.yml points web.searchProvider at this plugin and re-enables tool-web, so the "
      + "standard web_search tool is served by this plugin's provider on every product build.",
    async run() {
      const started = await startLiveHost();
      try {
        const queried = [];
        const result = await withFetch((url) => {
          if (url.startsWith("https://www.bing.com/search")) {
            const query = new URL(url).searchParams.get("q") ?? "";
            queried.push(query);
            return new Response(bingHtml(query));
          }
          return new Response("blocked", { status: 503 });
        }, () => execute(started.ctx, "web_search", { queries: ["one", "one", "two"] }));

        assert.equal(result.isError, false, JSON.stringify(result.value ?? result.content));
        // The host deduplicates the query list before it reaches the provider.
        assert.deepEqual([...queried].sort(), ["one", "two"]);

        // Validate with the host's own declared output contract for web_search,
        // so a host that adds fields to it stays compatible.
        const schema = started.ctx.tools.get("web_search").output.schema;
        assert.deepEqual(await validateWithHost(schema, result.value), []);
        assert.ok(result.value.sources.length > 0);
        // The plugin's own budget declaration has to survive the patch.
        assert.equal(started.ctx.tools.get("web_search").timeoutMs, 60_000);
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-010",
    title: "the real tool runtime accepts the bare JSON Schemas of all three plugin tools",
    depends:
      "The plugin hands defineTool raw JSON Schema for parameters and output. The host asserts the "
      + "enforced subset at registration, so a narrowed subset would stop the plugin from loading.",
    async run() {
      const started = await startLiveHost({ config: { platforms: ["github"] } });
      try {
        const tools = (await loadHostModule("@deepseek-ai/dsh-tools")).module;
        for (const name of ["free_search_test", "platform_search", "advanced_search"]) {
          const definition = started.ctx.tools.get(name);
          assert.ok(definition, `${name} is not registered`);
          // The host's own assertions, on the schemas as the host stored them.
          tools.assertObjectJsonSchema(definition.parameters);
          tools.assertSupportedJsonSchema(definition.output.schema);
          // Model-facing projection must carry the tool; schemas() is what the
          // host sends to the model.
          const schema = started.ctx.tools.schemas().find((row) => row.name === name);
          assert.ok(schema?.description, `${name} reached the model without a description`);
        }

        // Reverse control on the same assertion path: the host's subset check
        // is not a no-op, so a future narrowing really would be caught here.
        assert.throws(() => tools.assertObjectJsonSchema({ type: "object", properties: { q: { type: "bogus-type" } } }));
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-011",
    title: "advanced_search executes on the real runtime and its value passes its own output contract",
    depends:
      "advanced_search returns a lossless-JSON object the host validates against the tool's declared "
      + "output schema, and finalizeContent must hand back content blocks, not a bare string.",
    async run() {
      const started = await startLiveHost();
      try {
        const result = await withFetch(bingOnly, () =>
          execute(started.ctx, "advanced_search", { query: "advanced", maxResults: 2, engine: "bing" }));
        assert.equal(result.isError, false, JSON.stringify(result.value ?? result.content));
        const schema = started.ctx.tools.get("advanced_search").output.schema;
        assert.deepEqual(await validateWithHost(schema, result.value), []);
        assert.equal(result.value.provider, "bing");
        assert.ok(result.value.sources.length > 0);
        // finalizeContent: the host only accepts an array of content blocks.
        assert.ok(Array.isArray(result.content));
        assert.ok(result.content.some((block) => block.type === "text" && block.text.includes("results.test")));

        // Reverse control through the same tool: a blank query is refused by the
        // plugin and surfaces as a tool error, not a crash of the runtime.
        const blank = await execute(started.ctx, "advanced_search", { query: "   " });
        assert.equal(blank.isError, true);
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-012",
    title: "platform_search executes on the real runtime and a disabled platform is a tool error",
    depends:
      "platform_search reads the enabled-platform list out of the live settings value and throws for a "
      + "disabled one; the host has to turn that throw into an error result rather than tearing down.",
    async run() {
      const started = await startLiveHost({ config: { platforms: ["github"] } });
      // Both platforms answer successfully. If reddit's endpoint refused
      // instead, the reverse control below would pass whether or not the
      // disabled-platform check still exists.
      const platformWorld = (url, _init, calls) => {
        if (url.startsWith("https://api.github.com/search/repositories")) {
          return Response.json({
            items: [{ html_url: "https://github.com/a/b", full_name: "a/b", description: "Harness", stargazers_count: 7 }],
          });
        }
        if (url.startsWith("https://old.reddit.com/search.json")) {
          return Response.json({ data: { children: [{ data: { url: "https://r.test/1", title: "one" } }] } });
        }
        calls.push({ url, unexpected: true });
        return new Response("blocked", { status: 503 });
      };
      try {
        const result = await withFetch(platformWorld, () =>
          execute(started.ctx, "platform_search", { platform: "github", query: "harness", maxResults: 2 }));

        assert.equal(result.isError, false, JSON.stringify(result.value ?? result.content));
        const schema = started.ctx.tools.get("platform_search").output.schema;
        assert.deepEqual(await validateWithHost(schema, result.value), []);
        assert.equal(result.value.platform, "github");
        assert.ok(result.value.sources.length > 0);

        // Reverse control on the same path: reddit is not in this profile's
        // enabled list, so the live settings value really reached the tool. It
        // must be refused before any request goes out, which is why the scripted
        // reddit endpoint would have answered.
        const seen = [];
        const disabled = await withFetch(platformWorld, (calls) => {
          seen.push(calls);
          return execute(started.ctx, "platform_search", { platform: "reddit", query: "harness" });
        });
        assert.equal(disabled.isError, true, JSON.stringify(disabled.value ?? disabled.content));
        assert.deepEqual(seen[0], [], "a disabled platform still reached the network");
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-013",
    title: "free_search_test executes on the real runtime and reports an unconfigured engine",
    depends:
      "free_search_test is the plugin's own diagnostic tool; its rows must satisfy its declared output "
      + "schema on the host, including the engine rows that fail without touching the network.",
    async run() {
      const started = await startLiveHost();
      try {
        const result = await withFetch(() => {
          throw new Error("free_search_test must not reach the network for a key-less paid engine");
        }, () => execute(started.ctx, "free_search_test", { engines: ["perplexity", "deepseek-official"] }));

        assert.equal(result.isError, false, JSON.stringify(result.value ?? result.content));
        const schema = started.ctx.tools.get("free_search_test").output.schema;
        assert.deepEqual(await validateWithHost(schema, result.value), []);
        assert.deepEqual(result.value.results.map((row) => row.engine), ["perplexity", "deepseek-official"]);
        for (const row of result.value.results) {
          assert.equal(row.status, "fail");
          assert.ok(row.error.length > 0);
        }
        assert.ok(result.content.some((block) => block.type === "text" && block.text.includes("perplexity")));
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-014",
    title: "the real system prompt service carries the plugin section and refreshes it on a settings write",
    depends:
      "The plugin re-registers its prompt section whenever settings change, so the agent is never told "
      + "an engine the user already switched away from.",
    async run() {
      const started = await startLiveHost({ config: { provider: "bing" } });
      try {
        const before = await promptSection(started.ctx);
        assert.ok(before, "the plugin's section is not in the real prompt assembly");
        assert.ok(JSON.stringify(before).includes("Current engine: bing"));

        // Write through the plugin's own bridge, i.e. the real settings service.
        const described = await postJson(started.origin(), "/api/tokens-dsh-web-search-settings/describe", {});
        const view = described.body.value.namespaces[0];
        const mutated = await postJson(started.origin(), "/api/tokens-dsh-web-search-settings/mutate", {
          ns: BRIDGE_NS,
          expectedRevision: view.revision,
          ops: [{ op: "set", path: ["provider"], value: "searxng" }],
        });
        assert.equal(mutated.body.ok, true, JSON.stringify(mutated.body));

        // Both sides of this comparison are engine names the host has no default
        // for, so a plugin that stopped refreshing would stay on 'bing' and fail.
        const after = await promptSection(started.ctx);
        assert.ok(JSON.stringify(after).includes("Current engine: searxng"), JSON.stringify(after));
        assert.ok(!JSON.stringify(after).includes("Current engine: bing"));
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-015",
    title: "the real credentials service supplies engine keys and settings keys win over it",
    depends:
      "resolveApiKey() reads a settings key first, then ctx.get('credentials').resolve(<env name>) with a "
      + "plain string reference, then process.env. All three layers must keep working on the real service.",
    async run() {
      const started = await startLiveHost();
      const origin = started.origin();
      const search = "/api/tokens-dsh-web-search-settings/raw-search";
      const tavilyBody = { results: [{ url: "https://tavily.test/1", title: "one", content: "snippet" }] };
      const captureTavily = (seen) => (url, init) => {
        if (url.startsWith("https://api.tavily.com/search")) {
          seen.push(init?.headers ?? {});
          return Response.json(tavilyBody);
        }
        return new Response("blocked", { status: 503 });
      };
      try {
        assert.ok(started.ctx.get("credentials"), "the real host has no credentials service");

        // 1. No key anywhere: Tavily goes keyless. Without this the next two
        //    steps could both be reading the same constant.
        let seen = [];
        let answer = await withFetch(captureTavily(seen), () =>
          postJson(origin, search, { query: "keys", engine: "tavily" }));
        assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
        assert.equal(seen.length, 1);
        assert.equal(seen[0]["x-tavily-access-mode"], "keyless");
        assert.equal(seen[0].authorization, undefined);

        // 2. A credential written through the real service is picked up, with
        //    the plain-string reference the plugin passes.
        await started.ctx.credentials.set("TAVILY_API_KEY", "credential-layer-value");
        const resolved = await started.ctx.credentials.resolve("TAVILY_API_KEY");
        assert.equal(resolved.value, "credential-layer-value");
        seen = [];
        answer = await withFetch(captureTavily(seen), () =>
          postJson(origin, search, { query: "keys credential", engine: "tavily" }));
        assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
        assert.equal(seen[0].authorization, "Bearer credential-layer-value");

        // 3. A settings key wins over it, and neither value leaks out.
        const described = await postJson(origin, "/api/tokens-dsh-web-search-settings/describe", {});
        const view = described.body.value.namespaces[0];
        const mutated = await postJson(origin, "/api/tokens-dsh-web-search-settings/mutate", {
          ns: BRIDGE_NS,
          expectedRevision: view.revision,
          ops: [{ op: "set", path: ["tavilyApiKey"], value: "settings-layer-value" }],
        });
        assert.equal(mutated.body.ok, true, JSON.stringify(mutated.body));
        seen = [];
        answer = await withFetch(captureTavily(seen), () =>
          postJson(origin, search, { query: "keys settings", engine: "tavily" }));
        assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
        assert.equal(seen[0].authorization, "Bearer settings-layer-value");
        assert.ok(!JSON.stringify(answer.body).includes("settings-layer-value"));
        assert.ok(!JSON.stringify(answer.body).includes("credential-layer-value"));
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-016",
    title: "the plugin's three bridge routes serve real loopback HTTP on the host's web server",
    depends:
      "lib/client.js reaches the plugin only through webServer.register'd routes under "
      + "/api/tokens-dsh-web-search-settings; describe/mutate/raw-search is the whole client protocol.",
    async run() {
      const started = await startLiveHost();
      const origin = started.origin();
      const prefix = "/api/tokens-dsh-web-search-settings";
      try {
        assert.ok(origin, "the real web server published no origin");

        const described = await postJson(origin, `${prefix}/describe`, {});
        assert.equal(described.status, 200);
        assert.equal(described.body.ok, true);
        assert.equal(described.body.value.writable, true);
        // Only the plugin's own namespace is exposed, whatever else the host has.
        assert.deepEqual(described.body.value.namespaces.map((item) => item.ns), [BRIDGE_NS]);
        const view = described.body.value.namespaces[0];
        assert.equal(view.value.provider, "bing");
        assert.equal(typeof view.revision, "number");

        const mutated = await postJson(origin, `${prefix}/mutate`, {
          ns: BRIDGE_NS,
          expectedRevision: view.revision,
          ops: [
            { op: "set", path: ["provider"], value: "ddg-lite" },
            { op: "set", path: ["exaApiKey"], value: "bridge-secret-value" },
          ],
        });
        assert.equal(mutated.status, 200);
        assert.equal(mutated.body.ok, true, JSON.stringify(mutated.body));
        assert.equal(mutated.body.value.ns, BRIDGE_NS);
        assert.equal(mutated.body.value.value.provider, "ddg-lite");
        // The host redacts secrets on the way out; the value must not travel.
        assert.ok(!mutated.text.includes("bridge-secret-value"));
        assert.ok(mutated.body.value.secrets.some((secret) => secret.path.join(".") === "exaApiKey" && secret.set));

        const searched = await withFetch(bingOnly, () =>
          postJson(origin, `${prefix}/raw-search`, { query: "bridge", engine: "bing" }));
        assert.equal(searched.status, 200);
        assert.equal(searched.body.ok, true, JSON.stringify(searched.body));
        assert.equal(searched.body.value.provider, "bing");
        assert.ok(searched.body.value.sources.length > 0);

        // Reverse control on the same server: an unregistered sibling path is
        // not served, so the three hits above came from real registrations.
        const absent = await postJson(origin, `${prefix}/not-registered`, {});
        assert.notEqual(absent.status, 200);
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-017",
    title: "the bridge's loopback fence holds on the host's real web server",
    depends:
      "The bridge writes settings, so isLoopbackRequest() refuses anything that is not a same-origin "
      + "loopback POST. The fence reads request.socket.remoteAddress and the Host/Origin/Sec-Fetch-Site "
      + "headers as the host's server delivers them.",
    async run() {
      const started = await startLiveHost();
      const origin = started.origin();
      const requestPath = "/api/tokens-dsh-web-search-settings/describe";
      const send = (headers, method) => rawRequest(origin, { path: requestPath, method, headers, body: {} });
      try {
        // Same-origin POST: allowed. This is the control the refusals below are
        // measured against -- without it they could all be 403 for some other reason.
        assert.equal((await send({ origin })).status, 200);

        // A forged Host header that does not name loopback.
        assert.equal((await send({ host: "evil.test" })).status, 403);

        // A cross-site fetch, as the browser labels it.
        assert.equal((await send({ "sec-fetch-site": "cross-site" })).status, 403);

        // An Origin from somewhere else.
        assert.equal((await send({ origin: "http://evil.test" })).status, 403);

        // Reads are POST-only, so no link or image can trigger one.
        assert.equal((await send({}, "GET")).status, 405);
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-018",
    title: "DSH 0.2 derives the settings form from the volatile Config, persists writes, and notifies the fiber",
    skip: async () => {
      const host = await hostFacts();
      return host.legacySettings
        ? `DSH ${host.runtimeVersion} has no volatile settings projection (it installs an explicit section; see HOST-019)`
        : false;
    },
    depends:
      "On DSH 0.2 the plugin has no settings card of its own: the host projects a form from the entry's "
      + "volatile Config, writes it into the profile patch, and tells the fiber through loader/volatile-update. "
      + "The plugin reads the new value with config.get() and drops its result cache.",
    async run() {
      const started = await startLiveHost({ config: { provider: "bing", cache: true, cacheTtl: 5 } });
      try {
        const form = started.pluginSettings();
        assert.ok(form, `no settings form for ${ENTRY_ID}`);
        // Only the fields the settings page has to show, never the whole list.
        const fields = Object.keys(form.schema.refs[String(form.schema.uid)].dict);
        for (const field of ["provider", "bingMarket", "cache", "cacheTtl", "platforms", "tavilyApiKey"]) {
          assert.ok(fields.includes(field), `${field} did not survive the projection`);
        }
        assert.equal(form.value.provider, "bing");

        const fiber = started.entryFiber();
        assert.ok(fiber, "the host published no entry for the plugin");
        await started.ctx.settings.update(ENTRY_ID, { provider: "ddg", cacheTtl: 4 }, form.revision);

        const after = started.pluginSettings();
        assert.equal(after.value.provider, "ddg");
        assert.equal(after.value.cacheTtl, 4);
        // The live Config reference the plugin keeps, read exactly as it reads it.
        assert.equal((fiber.config.get?.() ?? fiber.config).provider, "ddg");
        // Durable, not just in memory.
        assert.ok(readFileSync(started.patchPath, "utf8").includes("ddg"));

        // The notification itself is observable in the plugin's own behaviour: a
        // result it had cached must not be served after a settings write. The
        // write below changes `lang`, which is not part of the plugin's cache
        // key, so only the loader/volatile-update listener can explain the miss
        // -- a plugin that stopped listening would answer "hit" and fail here.
        await started.ctx.settings.update(ENTRY_ID, { cache: true, cacheTtl: 5 }, started.pluginSettings().revision);
        const origin = started.origin();
        const search = "/api/tokens-dsh-web-search-settings/raw-search";
        const probe = () => withFetch(bingOnly, () => postJson(origin, search, { query: "cache probe" }));

        const first = await probe();
        assert.equal(first.body.ok, true, JSON.stringify(first.body));
        assert.equal(first.body.value.cache, "miss");
        assert.equal((await probe()).body.value.cache, "hit", "the plugin is not caching at all");

        await started.ctx.settings.update(ENTRY_ID, { lang: "en" }, started.pluginSettings().revision);
        assert.equal((await probe()).body.value.cache, "miss", "loader/volatile-update did not reach the plugin");
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-019",
    title: "DSH 0.1 installs the plugin's own settings section and feeds changes back into it",
    skip: async () => {
      const host = await hostFacts();
      return host.legacySettings
        ? false
        : `DSH ${host.runtimeVersion} dropped installSettingsSection (the form is derived instead; see HOST-018)`;
    },
    depends:
      "On DSH 0.1 the plugin calls installSettingsSection(ctx, 'free-search', Config, entry, {setSource, onChange}). "
      + "setSource is how it reads live values at all, and onChange is how it drops its result cache.",
    async run() {
      const started = await startLiveHost({ config: { provider: "bing", cache: true, cacheTtl: 5 } });
      try {
        // The section is installed under the plugin's own namespace, not the entry id.
        const form = started.ctx.settings.describe({ redactSecrets: true })
          .find((row) => String(row.ns) === BRIDGE_NS);
        assert.ok(form, `the plugin's section is not installed as "${BRIDGE_NS}"`);
        const fields = Object.keys(form.schema.refs[String(form.schema.uid)].dict);
        for (const field of ["provider", "bingMarket", "cache", "cacheTtl", "platforms", "tavilyApiKey"]) {
          assert.ok(fields.includes(field), `${field} is missing from the installed section`);
        }
        assert.equal(form.value.provider, "bing");
        // DSH 0.1 refuses in-process writes unless the provider says it is writable.
        assert.notEqual(started.ctx.settings.writable, false);

        const origin = started.origin();
        const search = "/api/tokens-dsh-web-search-settings/raw-search";
        const probe = () => withFetch(bingOnly, () => postJson(origin, search, { query: "cache probe" }));

        const first = await probe();
        assert.equal(first.body.ok, true, JSON.stringify(first.body));
        assert.equal(first.body.value.cache, "miss");
        assert.equal((await probe()).body.value.cache, "hit", "the plugin is not caching at all");

        // A real write through the host's settings service has to reach both
        // hooks: setSource (the value the plugin reports changes) and onChange
        // (the cache drops). `lang` is not part of the cache key, so only
        // onChange can explain the miss.
        await started.ctx.settings.mutate(BRIDGE_NS, [{ op: "set", path: ["provider"], value: "searxng" }]);
        const described = await postJson(origin, "/api/tokens-dsh-web-search-settings/describe", {});
        assert.equal(described.body.value.namespaces[0].value.provider, "searxng");
        assert.ok(JSON.stringify(await promptSection(started.ctx)).includes("Current engine: searxng"));
        assert.equal((await probe()).body.value.cache, "miss", "onChange did not reach the plugin");
        assert.equal((await probe()).body.value.cache, "hit");
        await started.ctx.settings.mutate(BRIDGE_NS, [{ op: "set", path: ["lang"], value: "en" }]);
        assert.equal((await probe()).body.value.cache, "miss", "onChange did not reach the plugin");
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-020",
    title: "a stale revision through the bridge raises the host's SettingsConflictError",
    depends:
      "The bridge imports SettingsConflictError from the host and maps it to code 'settings-conflict' so the "
      + "engine picker reports a lost race instead of overwriting a newer value.",
    async run() {
      const started = await startLiveHost();
      const origin = started.origin();
      const prefix = "/api/tokens-dsh-web-search-settings";
      try {
        const described = await postJson(origin, `${prefix}/describe`, {});
        const view = described.body.value.namespaces[0];

        // Someone else writes first, so the revision we hold goes stale.
        const won = await postJson(origin, `${prefix}/mutate`, {
          ns: BRIDGE_NS,
          expectedRevision: view.revision,
          ops: [{ op: "set", path: ["provider"], value: "ddg" }],
        });
        assert.equal(won.body.ok, true, JSON.stringify(won.body));

        const lost = await postJson(origin, `${prefix}/mutate`, {
          ns: BRIDGE_NS,
          expectedRevision: view.revision,
          ops: [{ op: "set", path: ["provider"], value: "bing" }],
        });
        assert.equal(lost.body.ok, false, JSON.stringify(lost.body));
        // 'internal' here would mean the host threw something the bridge no
        // longer recognises -- exactly the drift this case exists for.
        assert.equal(lost.body.code, "settings-conflict", JSON.stringify(lost.body));

        // The loser did not overwrite the winner.
        const now = await postJson(origin, `${prefix}/describe`, {});
        assert.equal(now.body.value.namespaces[0].value.provider, "ddg");

        // Reverse control on the same path: a namespace the plugin does not own
        // is refused before any write is attempted.
        const foreign = await postJson(origin, `${prefix}/mutate`, {
          ns: ENTRY_ID,
          ops: [{ op: "set", path: ["provider"], value: "bing" }],
        });
        assert.equal(foreign.body.ok, false);
        assert.equal(foreign.body.code, "settings-not-exposed");
      } finally {
        await started.dispose();
      }
    },
  },

  {
    id: "HOST-021",
    title: "the host's own gate admits this plugin on every runtime it claims and refuses the next major",
    skip: async () => {
      const host = await hostFacts();
      return host.hasCompatibilityEvaluator
        ? false
        : `DSH ${host.runtimeVersion} has no evaluatePluginCompatibility (the 0.1 app-boot never gated plugins); `
          + "any 0.2 host judges all three runtimes, so the matrix stays complete";
    },
    depends:
      "The host decides from peerDependencies alone whether this plugin loads. A one-sided range would admit "
      + "an unseen major; an upper bound without -0 would admit that major's prereleases.",
    async run() {
      const { evaluatePluginCompatibility } = (await loadHostModule("@deepseek-ai/dsh-app-boot")).module;
      const pkg = manifest();
      const peers = dshPeers(pkg);
      assert.ok(peers.length > 0, "the plugin declares no dsh peer, so the host cannot gate it at all");
      for (const [name, range] of peers) {
        const [lower, upper, ...rest] = range.split(" ");
        assert.deepEqual(rest, [], `${name}: expected a two-sided range, got "${range}"`);
        assert.ok(lower.startsWith(">="), `${name}: no lower bound in "${range}"`);
        assert.ok(upper?.startsWith("<"), `${name}: no upper bound in "${range}"`);
        assert.ok(upper?.endsWith("-0"), `${name}: upper bound "${upper}" admits that major's prereleases`);
        // optional keeps npm and pnpm from installing a second physical copy of
        // the runtime; the host reads the range either way.
        assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} is not an optional peer`);
      }
      // engines.dsh would decide alone on DSH 0.2.1 and be ignored on 0.2.0, so
      // the two product lines would disagree about the same plugin.
      assert.equal(pkg.engines?.dsh, undefined);

      for (const runtime of CLAIMED_RUNTIMES) {
        assert.equal(evaluatePluginCompatibility(pkg, {}, runtime), undefined, `refused on ${runtime}`);
      }
      const refused = evaluatePluginCompatibility(pkg, {}, REFUSED_RUNTIME);
      assert.equal(refused?.runtimeVersion, REFUSED_RUNTIME, `admitted on ${REFUSED_RUNTIME}`);
      assert.deepEqual(Object.keys(unmet(refused)).sort(), peers.map(([name]) => name).sort());

      // Reverse control: the evaluator returns undefined both for "satisfied"
      // and for "no dsh peer at all". A peer no runtime can satisfy separates
      // the two and proves the ranges above were really compared.
      const probe = { ...pkg, peerDependencies: { ...pkg.peerDependencies, "@deepseek-ai/dsh-probe": ">=99.0.0" } };
      for (const runtime of [...CLAIMED_RUNTIMES, REFUSED_RUNTIME]) {
        const issue = evaluatePluginCompatibility(probe, {}, runtime);
        assert.equal(unmet(issue)?.["@deepseek-ai/dsh-probe"], ">=99.0.0", `idle evaluator on ${runtime}`);
      }
      assert.equal(evaluatePluginCompatibility({ ...pkg, peerDependencies: {} }, {}, REFUSED_RUNTIME), undefined);
    },
  },

  {
    id: "HOST-022",
    title: "the shipped client module drives the real bridge over real HTTP and switches the engine",
    depends:
      "lib/client.js is the engine picker. It posts describe/mutate at the bridge prefix with its own payload "
      + "shape and reads value.provider and value.lang out of the reply; the server side of that protocol is "
      + "the plugin's own routes on the host's web server. The commandUi and locale services it registers "
      + "against are covered by HOST-002 on the pinned harness, because the staged client bundles need the "
      + "renderer's third-party closure.",
    async run() {
      const { readFile } = await import("node:fs/promises");
      const vm = (await import("node:vm")).default;
      const started = await startLiveHost();
      const origin = started.origin();
      try {
        // Load the shipped client bundle through the loader protocol it targets.
        let registration;
        const commandUi = {
          register(value) { registration = value; return () => { registration = undefined; }; },
        };
        const sctx = {
          get: (name) => (name === "commandUi" ? commandUi : undefined),
          effect: (run) => { run(); },
        };
        const clientCtx = { inject: (_names, run) => { run(sctx); } };
        const base = origin;
        const context = vm.createContext({
          console,
          URL,
          AbortController,
          // A browser supplies the page origin for the relative bridge paths.
          fetch: (input, init) => fetch(new URL(String(input), base), init),
          Response,
          window: { __ModuleLoader__: { load: (value) => { context.__client__ = value.factory(); } } },
        });
        vm.runInContext(await readFile(path.join(pluginRoot, "lib", "client.js"), "utf8"), context);
        const client = context.__client__;
        // Arrays from the vm realm are not reference-equal to this realm's.
        assert.deepEqual([...client.inject], ["commandUi"]);
        client.apply(clientCtx);
        assert.ok(registration, "the client module registered no command");
        assert.equal(registration.name, "tokens-dsh-web-search");

        // The picker's option list comes from the real bridge and the real
        // settings service: the active engine is this profile's 'bing'.
        const activeIn = (list) => [...list].filter((option) => option.active).map((option) => option.id);
        const options = await registration.ui.options({ sessionId: "host-contract" }, new AbortController().signal);
        assert.deepEqual(activeIn(options), ["bing"]);
        assert.ok([...options].some((option) => option.id === "searxng"));

        // Selecting writes through the bridge into the real settings service.
        await registration.ui.onSelect({ id: "ddg-lite" });
        const described = await postJson(origin, "/api/tokens-dsh-web-search-settings/describe", {});
        assert.equal(described.body.value.namespaces[0].value.provider, "ddg-lite");
        const reread = await registration.ui.options({ sessionId: "host-contract" }, new AbortController().signal);
        assert.deepEqual(activeIn(reread), ["ddg-lite"]);

        // Reverse control on the same path: an engine the picker does not list
        // is refused before it reaches the bridge, and nothing is written.
        await assert.rejects(() => registration.ui.onSelect({ id: "not-an-engine" }));
        const unchanged = await postJson(origin, "/api/tokens-dsh-web-search-settings/describe", {});
        assert.equal(unchanged.body.value.namespaces[0].value.provider, "ddg-lite");
      } finally {
        await started.dispose();
      }
    },
  },
];
