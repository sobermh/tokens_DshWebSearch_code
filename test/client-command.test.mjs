import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
  const plugin = registration.factory((id) => {
    if (id === "react") return {};
    if (id === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
    throw new Error(`unexpected client dependency: ${id}`);
  });
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
