# 宿主接口与真实宿主契约用例

本页是「插件用到的每一个宿主接口」和「哪条用例对真实宿主真调了它一次」的逐条对照。
背景：DSH 0.2.1 把网关 peer 改必填，连接中心在产品 0.7.0–0.7.3 四个版本全坏却没被发现，
原因是插件自己的用例把宿主打桩。所以本仓库的宿主契约用例一律跑在真实宿主上。

## 怎么跑

```
# 门禁用法：只认一个环境变量，指向 staged 宿主的 dsh-plugin-desktop 目录
DSH_HOST_ROOT=…/TokensCowork/.build/desktop/dsh-plugin-desktop  npm run check:host

# 本地一次跑多个宿主（门禁不传这个）
DSH_HOST_ROOTS="…/.build/desktop/dsh-plugin-desktop;…/.build/desktop-v060/dsh-plugin-desktop;…/.build/desktop-v0525/dsh-plugin-desktop" npm run check:host

# 不碰宿主的离线用例
npm test -- --standalone

# 连源码态宿主的 HOST-001…004 一起跑（需要装好依赖的外层产品检出）
npm test -- --outer-root …/TokensCowork
```

`check:host` 对每条 `HOST-nnn` 打一行 `PASS` / `FAIL` / `NOT EXECUTED`。
**没有 `DSH_HOST_ROOT` 时每条都报 `NOT EXECUTED`，退出码非 0**——门禁不会把「什么都没跑」读成「没问题」。
只有「本代宿主没有这个接口」这一种未执行理由会被单列而不判失败，其余未执行（包括缺宿主）一律失败。

**`npm run test:cases` 带宿主跑时是同一个口径**（产品门禁第 21 步就是这么跑的）：两条汇总路径
共用同一个判定函数，带宿主线理由的跳过打一行 `NOT EXECUTED` 且不置退出码，别的未执行仍是
`INCOMPLETE` 且退出码非 0。不带宿主时所有 `HOST-nnn` 都因为缺宿主而未执行，退出码仍然非 0。

内部映射（门禁不需要知道）：`TOKENS_HOST_ROOT = DSH_HOST_ROOT`。
`TOKENS_OUTER_ROOT`（HOST-001…004 用的源码态外层检出）**不从 DSH_HOST_ROOT 推导**：
那条路要外层检出自己的 `node_modules` 装好且是当前的，而主检出的 harness 安装经常过期，
会以一个与本插件无关的三方包缺失失败。它改为 `--outer-root` 显式开启，不给就报未执行，
并指向覆盖同一批接口的 staged 宿主用例。

## 真实到什么程度

`test/host-contract/live-host.mjs` 用**宿主自己的 launcher**（`@deepseek-ai/dsh-app-boot` 的 `boot`）
起一个一次性 profile，条目全是真实服务：settings（0.2 的 `dsh-settings` + `config-editor`，
0.1 的 `dsh-settings-file`）、`tools`、`web`、`host-webserver`（真绑 127.0.0.1 随机端口）、
`credentials-local`、`system-prompt`，以及上游 `tool-web`。插件由**真实 Loader 按 `inject` 激活**。

- 宿主侧**没有任何打桩**。
- 脚本化的只有外部世界（Bing / DuckDuckGo / Tavily / GitHub / Reddit …）——那不是宿主接口。
- 插件的 `@deepseek-ai/*` 导入由 `test/host-contract/host-modules.mjs` 的只读 resolve hook
  指向 staged 宿主，所以跑的是产品真正随包分发的那份运行时。
- 内置插件的坑：staged 宿主的 `node_modules/tokens-dsh-web-search` 是指向它自己
  `product-plugins/tokens-dsh-web-search` 的 junction。被测代码必须是工作树那份，
  **HOST-005 把这件事做成断言**，所以用例不可能在悄悄测宿主钉住的旧版本。
- 夹具的 settings / credentials 文档路径在 boot 之后被断言必须落在临时目录内。
  settings-file 的配置键是 `path`；写成别的名字它会回落到 `resolveDshHome()/settings.yaml`，
  也就是开发者真实的 `$DSH_HOME` 文档。

## 接口 ↔ 用例

| 宿主接口（插件真正用到的） | 用例 |
|---|---|
| 插件入口与 `@deepseek-ai/*` 的解析来源 | HOST-005 |
| `@deepseek-ai/dsh-settings`：`SettingsConflictError` | HOST-006, HOST-020 |
| `@deepseek-ai/dsh-settings`：`installSettingsSection` / `settingsNamespace`（0.1 分支判定） | HOST-006, HOST-019 |
| `@deepseek-ai/dsh-tools`：`defineTool` | HOST-006, HOST-010 |
| `@deepseek-ai/schemastery`：`z.object/string/boolean/number/array`、`.default`、`.role("secret")`、`.volatile()` | HOST-006, HOST-018, HOST-019 |
| Loader：按 `export const inject = ["web"]` 激活 `apply(ctx, config)` | HOST-007 |
| Loader：条目 config（0.2 是 volatile 引用，用 `config.get()` 读） | HOST-018 |
| `ctx.fiber.entry.options.id`（0.2 的设置命名空间） | HOST-016, HOST-018 |
| `ctx.logger.warn` | 随每条搜索回退路径真实调用（HOST-008/009/011） |
| `ctx.get("credentials")` + `credentials.resolve(<env 名>)` 读 `.value` | HOST-015 |
| `ctx.web.registerSearchProvider`（provider 契约 `{id, available, search}`）与按 id 选中 | HOST-008 |
| `ctx.web.search` 的 `WebSearchRequest` / `WebSearchResult` 词汇 | HOST-008 |
| 上游 `tool-web` 的 `web_search`（由 `cordis.patch.yml` 接管） | HOST-009 |
| `ctx.inject([...], cb)` + `sctx.effect(fn, label)` 与释放 | HOST-007（激活与未激活两侧） |
| `sctx.webServer.register({kind:"exact", path, handler})` → disposer | HOST-016 |
| 桥接的回环/同源围栏在真实 server 上的请求形状 | HOST-017 |
| `settings.describe({redactSecrets:true})`：`ns/schema/value/secrets/revision` | HOST-016, HOST-018, HOST-019 |
| `settings.mutate(ns, ops, expectedRevision)` 与冲突 | HOST-016, HOST-019, HOST-020 |
| `settings.update` 落盘到 profile 的 `cordis.patch.yml` | HOST-018 |
| `settings.writable` | HOST-016, HOST-019 |
| `ctx.on("loader/volatile-update")`（0.2 的值变更通知） | HOST-014, HOST-018 |
| `installSettingsSection` 的 `setSource` / `onChange`（0.1 的值变更通知） | HOST-019 |
| `sctx.tools.register(defineTool(...))` 与宿主对裸 JSON Schema 的子集断言 | HOST-010 |
| `ctx.tools.execute` 与宿主对返回值的输出契约校验、`finalizeContent` 的内容块 | HOST-011, HOST-012, HOST-013 |
| `sctx.systemPrompt.section({name, order, text})` → disposer，与真实 `assemble()` | HOST-014 |
| 客户端 `window.__ModuleLoader__.load`，与桥接协议（describe / mutate 的载荷与回包字段） | HOST-022 |
| 客户端 `commandUi.register` / `locale.register` / `locale.bind` | HOST-002（源码态宿主，见下） |
| `evaluatePluginCompatibility`（dsh peer 门禁） | HOST-021, HOST-004 |

## 模拟边界（三处，都不是宿主接口）

1. **外部搜索服务**。Bing / DDG / SearXNG / Tavily / Exa / Keenable / Perplexity /
   DeepSeek / GitHub / V2EX / Bilibili / Reddit 的响应是脚本化的。真打网络会让用例不稳定，
   而且它们不是宿主契约。引擎适配器自己的解析由离线用例（ENG-*、PLAT-*）覆盖。
2. **客户端的 `commandUi` / `locale` 服务**。staged 宿主里这两个服务只以
   `__ModuleLoader__` 客户端 bundle 形式存在，要挂起来得先满足渲染层约十九个三方包
   （simple-icons / shiki / katex / micromark …）——那是上游预构建分发的闭包。
   所以这两个服务的真实宿主覆盖留在 **HOST-002**（源码态、钉住的 harness 检出）；
   HOST-022 只驱动客户端模块真正跨进程的那一段：对真实 web server 上的桥接发真实 HTTP。
3. **`electron` / 桌面外壳**。本插件不碰。

## 用例口径（为什么它们不会在每次升级时乱红）

- 只断言插件真正读的接口、字段、事件。宿主新增字段、新增事件、新增设置命名空间、
  新增 endpoint 一律视为兼容。
- 形状校验用**宿主自己的** schema 与校验器：`ctx.tools.get(name).output.schema` 配
  `validateJsonSchemaValue`，`assertObjectJsonSchema` / `assertSupportedJsonSchema`，
  `settings.describe()` 返回的 schemastery 文档。不手写期望对象。
- 不断言词表大小、endpoint 全清单、宿主内部字段顺序或数量。
- 跨代差异一律**探测**，不按版本号猜；某代没有的接口显式报 `NOT EXECUTED` 并说明理由。
- 每条用例的 `depends` 写明它保护的是插件的哪个行为，宿主升级时红了能一眼分清
  「插件该改」还是「宿主破坏了契约」。

## 空转防护

`scripts/verify-host-contract-mutations.mjs` 逐个把被测路径弄坏，跑 `--host-contracts`，
要求**恰好**预期的那几条变红：少了说明用例空转，多了说明用例写得太死、以后升级会乱红。

```
DSH_HOST_ROOT=…  node scripts/verify-host-contract-mutations.mjs
```

2026-10-22 实测：0.2.1-rc.2 上 16/16、0.2.0-rc.2 上 16/16、0.1.5-rc.2 上 14/14 全部命中
（每个宿主跳过只对另一代有意义的那几个变异）。其中 M08 第一次就抓出 HOST-012 的反向
对照是空转的——被禁平台之所以报错是因为脚本化的 reddit 端点返回 503，而不是因为插件的
开关还在；现在脚本化世界让 reddit 也成功，并额外断言「被禁平台一个请求都不发」。

## 未执行矩阵（2026-10-22 实测）

| 用例 | 0.2.1-rc.2 | 0.2.0-rc.2 | 0.1.5-rc.2 | 未执行的理由 |
|---|---|---|---|---|
| HOST-005…017, 020, 022 | PASS | PASS | PASS | — |
| HOST-018（0.2 派生表单） | PASS | PASS | NOT EXECUTED | 0.1 没有 volatile 投射，由 HOST-019 覆盖 |
| HOST-019（0.1 显式分区） | NOT EXECUTED | NOT EXECUTED | PASS | 0.2 删掉了 `installSettingsSection`，由 HOST-018 覆盖 |
| HOST-021（peer 门禁） | PASS | PASS | NOT EXECUTED | 0.1 的 app-boot 没有 `evaluatePluginCompatibility`；任一 0.2 宿主都能把三个运行时一起判出来，矩阵仍是全的 |
| HOST-001…004（源码态） | 需 `--outer-root` | 需 `--outer-root` | 需 `--outer-root` | 见上「怎么跑」 |
