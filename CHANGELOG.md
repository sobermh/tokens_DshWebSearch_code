# 变更记录

本文件记录发布到私有 registry `https://npm.tokensapi.ai/` 的版本。
0.2.1 之前的细节见 git 历史。

## [0.2.2] - 2026-10-21

### 变更

- **两个 dsh peer 收窄为双端区间并标记 optional。** `@deepseek-ai/dsh-settings` 和
  `@deepseek-ai/dsh-tools` 原先写的是单端的 `>=0.1.0-rc.6`，DSH 0.3 也会被宿主放行；
  现在是 `>=0.1.0-rc.6 <0.3.0-0`，上界带 `-0` 才能连 0.3 的预发布版一起拦住（semver
  把预发布版排在正式版之前）。`peerDependenciesMeta.optional` 让 npm 和 pnpm 不去解析
  安装第二份运行时副本；宿主的兼容判定只看区间、不看这个标记。运行时行为不变，改的是
  与事实不符的声明：0.1.5-rc.2 / 0.2.0-rc.2 / 0.2.1-rc.2 三条线照旧放行。

### 新增

- **两条依赖真实宿主的常驻回归用例。** `--outer-root` 可用时真跑，否则按执行器规则记为
  未完成，不静默跳过。
  - HOST-003 在真实 `app-boot` 上跑完 DSH 0.2 的设置链路：volatile Config 派生出设置
    表单、`settings.update` 写进 `cordis.patch.yml` 并通知插件、插件自己的 loopback
    桥接把 profile 条目 id 映射成 free-search 且密钥保持脱敏。
  - HOST-004 用宿主自己的 `evaluatePluginCompatibility` 核对 peer 区间：三条在用运行时
    放行、`0.3.0-rc.1` 被拦，并用一条无法满足的假 peer 做反向对照，确认「放行」不是
    评估器空转。

## 0.2.1 - 2026-10-15

### 修复

- **适配 DSH 0.2 的设置契约。** `@deepseek-ai/dsh-settings` 在 0.2 移除了
  `installSettingsSection`、`settingsNamespace` 以及 `SettingsForms.installSection`，
  原先的静态命名导入会让插件在真机 0.2 宿主上完全无法加载。现在改为按宿主实际导出
  探测契约：0.1 宿主仍走显式 section；0.2 宿主声明 volatile Config，从
  `loader/volatile-update` 接收取值变更，并把桥接层的 free-search 命名空间映射到
  profile 条目 id。
- **修正掩盖了上述问题的宿主集成夹具。** 兼容层此前无条件伪造两个已移除的导出，
  会话桩早于按会话建索引的命令目录，宿主版本还被钉成 0.1 字面量。现在兼容层只镜像
  宿主真实发布的导出，会话桩提供 retained binding，版本断言改读 `product.json` 的
  `runtimeVersion`。

### 说明

- 搜索引擎的选择仍由插件在引擎不可用时自动回退，不依赖用户在设置界面切换。

[0.2.2]: https://github.com/sobermh/tokens_DshWebSearch_code/compare/v0.2.1...v0.2.2
