# tokens_DshWebSearch_code

本项目是本地维护的 DeepSeek Harness 联网搜索插件，npm 包名为 `tokens-dsh-web-search`。

## 功能

- 为原生 `web_search` 提供 Bing、DuckDuckGo、AnySearch 和 SearXNG 等搜索来源。
- 支持 Exa、Tavily、Keenable、Perplexity 和 DeepSeek API 搜索。
- 支持时间范围过滤、平台搜索、网页抓取、结果缓存和设置页切换。
- 不包含远程版本检查或一键升级逻辑，代码更新完全由本仓库维护。

## 本地安装

在项目目录外执行：

```powershell
dsh plugin --profile desktop add file:C:\path\to\tokens_DshWebSearch_code
```

插件变更后需要重启 DSH Desktop。默认情况下，补丁会把 `web.searchProvider` 设置为 `ddg`，实际搜索引擎可在插件设置中选择。

## 开发

```powershell
pnpm install
pnpm test
pnpm test:cases
node --check lib/index.js
node --check lib/client.js
```

完整功能测试用例统一维护在 [`test/test_cases.csv`](test/test_cases.csv)。`pnpm test:cases`
会校验 CSV 和测试映射，执行全部用例，并在存在失败、跳过或未完成用例时返回非零。
要同时验证当前 TokensHarness 宿主中的真实 `web_search` 链路，传入已准备好依赖的外层仓库：

```powershell
pnpm test:cases -- --outer-root C:\path\to\tokens_TokensHarness_code
```

宿主链路会运行真实 Cordis、`dsh-web` 和 `tool-web`，仅替换外部网络响应；未提供可用外层仓库时，
对应测试会标记为未完成而不是通过。
若插件用 Node 20 做最低版本回归，而当前外层 Harness 要求更高版本，可再传入宿主 Node：

```powershell
pnpm test:cases -- --outer-root C:\path\to\tokens_TokensHarness_code --host-node C:\path\to\node.exe
```

核心文件：

- `lib/index.js`：搜索 provider、搜索工具、设置桥接和引擎实现。
- `lib/client.js`：DSH 设置页面。
- `cordis.patch.yml`：DSH bundle 注入配置。

## 许可

本项目沿用 MIT License。依据许可证要求，原始版权声明与许可文本保留在 `LICENSE` 中。
