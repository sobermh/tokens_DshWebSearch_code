# tokens_DshWebSearch_code

本项目是本地维护的 DeepSeek Harness 联网搜索插件，npm 包名为 `tokens-dsh-web-search`。

## 功能

- 为原生 `web_search` 提供 Bing、DuckDuckGo、AnySearch 和 SearXNG 等搜索来源。
- 支持 Exa、Tavily、Keenable、Perplexity 和 DeepSeek API 搜索。
- 支持时间范围过滤、平台搜索、结果缓存和 `/tokens-dsh-web-search` 命令切换首选引擎。
- 不注册插件设置卡；默认关闭原生 `web_fetch`，不覆盖宿主的工具执行和权限链路。
- 不包含远程版本检查或一键升级逻辑，代码更新完全由本仓库维护。

## 本地安装

在项目目录外执行：

```powershell
dsh plugin --profile desktop add file:C:\path\to\tokens_DshWebSearch_code
```

插件变更后需要重启 DSH Desktop。补丁禁用原生 DeepSeek 搜索 provider，并把
`web.searchProvider` 设置为 `ddg`（本插件的固定 provider ID），实际默认引擎为 Bing、市场为 zh-CN。
通过 `/tokens-dsh-web-search` 修改首选引擎，其余配置通过宿主 settings 的 `free-search` 命名空间维护。
命令跟随宿主 locale 提供中英文；没有 locale 服务时使用插件 `lang` 设置。

首选引擎有 1200ms 独占窗口，未得到可用结果时错峰竞速其他免费引擎；仍失败才串行尝试 API 兜底。
带时间过滤时优先选择支持过滤的引擎。全部失败会返回实际错误，自动回退不保证一定成功。
免费端点可能按 IP 限流、验证或调整接口，API 引擎可能计费，插件不保证不限次数或国内可达。

结果缓存最多 50 条、最长 5 分钟，回退结果使用配置 TTL 的五分之一；`cache=false` 或 `cacheTtl=0`
关闭缓存。设置变化清空缓存，在途旧配置结果不会写回新缓存；返回来源与缓存隔离。
外部取消会终止竞速且不补发后续请求，但无法强制停止不遵守 AbortSignal 的第三方实现。

## 开发

```powershell
pnpm install
pnpm test
pnpm test:cases
pnpm run check:host   # 真实宿主契约，需要 DSH_HOST_ROOT
node --check lib/index.js
node --check lib/client.js
node --check lib/hedged-race.js
```

### 真实宿主契约（HOST-005…022）

`pnpm run check:host` 对一个 staged 宿主把插件用到的每一个宿主接口各真调一次，
宿主侧全程不打桩。它只认一个环境变量：

```powershell
$env:DSH_HOST_ROOT = 'C:\path\to\TokensCowork\.build\desktop\dsh-plugin-desktop'
pnpm run check:host
```

每条 `HOST-nnn` 打一行 `PASS` / `FAIL` / `NOT EXECUTED`。没有 `DSH_HOST_ROOT` 时全部报
未执行且退出码非 0——不会把「什么都没跑」当成通过。本地要一次跑多个宿主，用
`DSH_HOST_ROOTS` 传分号分隔的列表（产品门禁不传这个）。
接口 ↔ 用例的逐条对照、模拟边界和未执行矩阵见
[`docs/host-interfaces.md`](docs/host-interfaces.md)；
`scripts/verify-host-contract-mutations.mjs` 用变异验证证明这些用例不是空转。

完整功能测试用例统一维护在 [`test/test_cases.csv`](test/test_cases.csv)。`pnpm test:cases`
会校验 CSV 和测试映射，执行全部用例，并在存在失败、跳过或未完成用例时返回非零。
`test/` 仅保留用例 CSV 和 [`run-test-cases.mjs`](test/run-test-cases.mjs) 两个文件；
断言、辅助函数及宿主集成夹具统一维护在执行器中，各组测试仍在独立 Node 进程运行。
`pnpm test` 与 `pnpm test:cases` 使用同一入口。宿主集成所需临时文件仅在运行时生成并清理。
CI 使用 `pnpm test -- --standalone` 运行独立回归；该模式只报告独立用例通过，宿主用例明确标记未执行。
要同时验证当前 TokensCowork 宿主中的真实 `web_search` 和聊天命令契约，传入已准备好依赖的外层仓库：

```powershell
pnpm test:cases -- --outer-root C:\path\to\TokensCowork
```

这条源码态链路（HOST-001…004）运行真实 Cordis、`dsh-web`、`tool-web`、`commandUi` 和 locale，替换网络与会话等外围服务；
未提供可用外层仓库时，对应测试会标记为未完成而不是通过。它需要外层检出自己的 `node_modules` 装好且是当前的，
所以不从 `DSH_HOST_ROOT` 推导——`check:host` 不跑它，只在报告里单列为未执行并指向覆盖同一批接口的 staged 宿主用例。
客户端 `commandUi` / locale 的真实宿主覆盖只在这条路上（HOST-002）。
测试组加载失败时，执行器会按组报告原始错误，不把 Node 的文件级失败误报为测试名称重复；
真实重名仍会导致非零退出，但不会中断后续测试组的结果收集。
移动仓库目录后，旧 `node_modules` 的绝对链接可能失效，需在插件和宿主各自目录按锁文件重新安装依赖。
宿主 `desktop/deepseek-harness` 使用自己的 `corepack pnpm`，不要套用外层的 Yarn；
本地缓存完整时可使用 `install --offline --frozen-lockfile --ignore-scripts` 恢复测试依赖，不触发安装脚本。
插件最低 Node 版本为 20.3.0（需要 `AbortSignal.any`）；当前外层 Harness 若要求更高版本，可再传入宿主 Node：

```powershell
pnpm test:cases -- --outer-root C:\path\to\TokensCowork --host-node C:\path\to\node.exe
```

核心文件：

- `lib/index.js`：搜索 provider、搜索工具、设置桥接和引擎实现。
- `lib/client.js`：隐藏设置卡，仅注册引擎切换命令。
- `lib/hedged-race.js`：引擎竞速、取消与串行兜底。
- `cordis.patch.yml`：DSH bundle 注入配置。

`lib/*.js` 是直接维护的运行源码，不是可删除的构建缓存。本项目没有额外编译步骤。
测试会在临时目录执行实际 `npm pack` 并通过系统 `tar` 核对产物，完成后清理，不安装或发布。
发布目标固定为私有 Registry `https://npm.tokensapi.ai/`；市场双语元数据要在下一次发布后才会生效。

## 许可

本项目沿用 MIT License。依据许可证要求，原始版权声明与许可文本保留在 `LICENSE` 中。
