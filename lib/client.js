window.__ModuleLoader__.load({
  id: "tokens-dsh-web-search",
  factory: () => {
    const BRIDGE_PREFIX = "/api/tokens-dsh-web-search-settings";
    const NS = "free-search";
    const LOCALE_NS = "tokens-dsh-web-search";
    const dictionaries = {
      zh: {
        description: "切换搜索引擎",
        free: "免费",
        current: "当前",
        metaSearch: "元搜索",
        unavailable: "搜索设置不可用",
        saveFailed: "搜索引擎切换失败",
        invalidEngine: "无效的搜索引擎",
      },
      en: {
        description: "Switch web search engine",
        free: "Free",
        current: "Current",
        metaSearch: "Meta-search",
        unavailable: "Search settings unavailable",
        saveFailed: "Failed to switch search engine",
        invalidEngine: "Invalid search engine",
      },
    };
    const ENGINES = [
      { id: "ddg", label: "DuckDuckGo · HTML", free: true },
      { id: "ddg-lite", label: "DuckDuckGo · Lite", free: true },
      { id: "bing", label: "Bing", free: true },
      { id: "anysearch", label: "AnySearch · AI", free: true },
      { id: "searxng", label: "SearXNG", free: true },
      { id: "exa", label: "Exa", free: true },
      { id: "tavily", label: "Tavily", free: true },
      { id: "keenable", label: "Keenable", free: true },
      { id: "perplexity", label: "Perplexity" },
      { id: "deepseek-official", label: "DeepSeek Official" },
    ];

    async function bridge(action, payload, signal) {
      const response = await fetch(`${BRIDGE_PREFIX}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (response.ok === false) throw new Error("bridge request failed");
      return response.json();
    }

    function apply(ctx) {
      ctx.inject(["commandUi"], (sctx) => {
        const commandUi = sctx.get("commandUi");
        if (!commandUi) return;
        const locale = sctx.get("locale");
        let language = "zh";
        let t = (key) => dictionaries[language][key];
        if (locale) {
          sctx.effect(() => locale.register(LOCALE_NS, dictionaries), "tokens-dsh-web-search: dictionaries");
          t = locale.bind(LOCALE_NS);
        }
        sctx.effect(() => commandUi.register({
          name: "tokens-dsh-web-search",
          description: () => t("description"),
          available: () => true,
          ui: {
            kind: "popupSelect",
            options: async (_session, signal) => {
              signal?.throwIfAborted();
              let view;
              try {
                const result = await bridge("describe", {}, signal);
                signal?.throwIfAborted();
                view = result.ok === true && result.value?.namespaces?.find((entry) => entry.ns === NS);
                if (!view) throw new Error("missing search settings");
              } catch {
                signal?.throwIfAborted();
                throw new Error(t("unavailable"));
              }
              language = view.value?.lang === "en" ? "en" : "zh";
              const current = view.value?.provider ?? "bing";
              return ENGINES.map((engine) => ({
                id: engine.id,
                label: `${engine.label}${engine.id === "searxng" ? ` · ${t("metaSearch")}` : ""} · ${engine.free ? t("free") : "API Key"}`,
                detail: engine.id === current ? t("current") : undefined,
                active: engine.id === current,
              }));
            },
            onSelect: async (option) => {
              if (!ENGINES.some((engine) => engine.id === option?.id)) {
                throw new Error(t("invalidEngine"));
              }
              try {
                const result = await bridge("mutate", {
                  ns: NS,
                  ops: [{ op: "set", path: ["provider"], value: option.id }],
                });
                if (result.ok !== true) throw new Error("mutation rejected");
              } catch {
                throw new Error(t("saveFailed"));
              }
            },
          },
        }), "tokens-dsh-web-search: command picker");
      });
    }

    return { apply, inject: ["commandUi"] };
  },
});
