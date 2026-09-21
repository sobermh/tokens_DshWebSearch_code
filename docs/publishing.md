# 发布说明

本插件发布到私有 registry `https://npm.tokensapi.ai/`，**不发布到 npmjs.org**。
包名为 `tokens-dsh-web-search`，发布账号为 `tokenscowork`。

## 工作流

`.github/workflows/publish-npm.yml`：

| 触发方式 | 行为 |
| --- | --- |
| push 到 `main` | 只做检查（安装依赖 + 单元测试） |
| pull request | 只做检查 |
| 手动运行，`release_tag` 留空 | 只做检查（默认） |
| 手动运行，`release_tag` 填已有版本标签 | 在该标签上重跑检查并发布（失败重试入口） |
| push `v*` 标签 | 校验标签与 `package.json` 版本一致、检查通过后发布 |

发布步骤只在 `github.repository == 'sobermh/tokens_DshWebSearch_code'` 时执行，
fork 仓库即使打了标签也只会跑检查。

## 发布流程

1. 改 `package.json` 的 `version`（只允许稳定版 `x.y.z`，预发布版本会被 `scripts/validate-release.mjs` 拒绝）。
2. 提交并推送到 `main`，确认检查通过。
3. 打标签并推送：

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. 在 Actions 页面确认 `Publish to Verdaccio` 步骤成功。

## 校验与护栏

`scripts/validate-release.mjs` 在装依赖之前运行，拦截四类事故：

- 包名被改动（例如 fork 后忘了改回来）；
- `publishConfig.registry` 缺失、指向公共源，或显式写了 `access: public`；
- 版本号不是稳定版（预发布版本不允许占用 `latest`）；
- 标签与 `package.json` 的版本对不上。

发布步骤里还有三道运行时护栏：

- **缺少 Secret 明确提示**：`VERDACCIO_PUBLISH_TOKEN` 为空时直接失败并说明要配哪个 Secret；
- **发布者校验**：`npm whoami` 必须等于 `tokenscowork`，否则拒绝发布；
- **禁止覆盖已发布版本**：publish 之前先 `npm view` 查同版本，命中就失败，要求改版本号而不是覆盖。

凭据只通过 `secrets.VERDACCIO_PUBLISH_TOKEN` 注入到 `NODE_AUTH_TOKEN` 环境变量，
由 `actions/setup-node` 写进 runner 的 `.npmrc`；不写入仓库文件、不打印到日志。

## 依赖来源

`actions/setup-node` 的 `registry-url` 只用于**发布**方向。安装依赖时显式指定公共源
（`pnpm install --frozen-lockfile --registry=https://registry.npmjs.org/`），
否则会拿私有源去解析公共依赖并返回 401。

CI 只跑 `pnpm test`（`node --test test/*.test.mjs`，离线可用）。
`pnpm test:cases` 需要真实联网和 `--outer-root` 参数，不进 CI。

## Fork 仓库注意事项

fork 出来的仓库，GitHub 默认会禁用 Actions，并且需要在仓库的 **Actions 页面**点一次
“I understand my workflows, go ahead and enable them”。

**只看 API 返回的 `active` 状态是不够的** —— 未完成页面确认时，API 仍可能把工作流报成
`active`，但推送不会真正触发运行。请到 Actions 页面确认启用后，再推一次验证。
