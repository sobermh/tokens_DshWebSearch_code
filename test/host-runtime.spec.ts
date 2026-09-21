import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import WebRuntime from "@deepseek-ai/dsh-web";
import * as ToolWeb from "@deepseek-ai/dsh-tool-web";

import * as WebSearchPlugin from "../lib/index.js";

function bingHtml(query: string): string {
  return "x".repeat(600) + [
    `<li class="b_algo"><h2><a href="https://results.test/${query}">${query}</a></h2><p>${query} snippet</p></li>`,
    `<li class="b_algo"><h2><a href="https://results.test/shared">shared</a></h2><p>shared snippet</p></li>`,
  ].join("");
}

describe("real TokensHarness web_search integration", () => {
  it("mounts the plugin provider and executes concurrent deduplicated queries through tool-web", async () => {
    const outerRoot = process.env.TOKENS_OUTER_ROOT;
    if (!outerRoot) throw new Error("TOKENS_OUTER_ROOT is required");
    const toolWebPackage = JSON.parse(await readFile(path.join(
      outerRoot,
      "desktop",
      "deepseek-harness",
      "packages",
      "web",
      "tool-web",
      "package.json",
    ), "utf8"));
    expect(toolWebPackage.version).toBe("0.1.5-rc.2");
    const settingsPatch = await readFile(path.join(
      outerRoot,
      "desktop",
      "patches",
      "dsh-settings@0.1.5-rc.1.patch",
    ), "utf8");
    expect(settingsPatch).toContain("function settingsNamespace(value)");
    expect(settingsPatch).toContain("function installSettingsSection(ctx, ns, schema, entry, hooks)");

    const started: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
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
        callId: "tokens-web-search-integration" as never,
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
    } finally {
      await toolFiber.dispose();
      await providerFiber.dispose();
      vi.unstubAllGlobals();
    }
  });
});
