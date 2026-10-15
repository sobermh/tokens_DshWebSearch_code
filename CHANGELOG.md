# 变更记录

本文件记录发布到私有 registry `https://npm.tokensapi.ai/` 的版本。
0.2.1 之前的细节见 git 历史。

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
