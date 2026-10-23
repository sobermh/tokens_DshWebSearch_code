# 变更记录

本文件记录发布到私有 registry `https://npm.tokensapi.ai/` 的版本。
0.2.1 之前的细节见 git 历史。

## [0.2.4] - 2026-10-23

### 修复

- **带宿主跑 `npm run test:cases` 时，「本宿主线不适用」被记成 INCOMPLETE 并把退出码置 1。**
  产品 Windows 质量门禁现在用 staging 宿主跑每个内置插件的 `test:cases`，于是 HOST-019
  （只在 DSH 0.1 上成立的显式设置分区）在 0.2.1-rc.2 上报告未执行——`check:host` 早就把
  这种带宿主线理由的跳过算作「已交代」，`test:cases` 却一律算未完成，门禁因此红。两条汇总
  路径现在共用同一个判定函数 `classifyCase`，口径不可能再分叉：理由以
  `NOT EXECUTED on this host line: ` 开头的跳过被单独列出、不致命；没有宿主、链接坏掉、
  不给理由的跳过仍然是 INCOMPLETE 并把退出码置 1，「什么都没跑」永远算不成通过。
  `test:cases` 的整条判定抽成纯函数，退出码口径本身也进了用例（TEST-005，含两次
  变异验证：弄坏判定或弄坏汇总都必须变红）。运行时代码没有改动。

### 变更

- **dsh peer 上界从 `<0.3.0-0` 放宽到 `<1.0.0-0`**（下界 `>=0.1.0-rc.6` 不动）。上界只挡
  大版本：内核跨 0.x 小版本时，契约全绿的插件不必为改一行声明重发一版；真正的守门人是
  真实宿主契约门禁，版本号本来就预测不了兼容性。HOST-021 与 HOST-004 的拒收对照版本
  同步改成 `1.0.0-rc.1`，并把 `0.3.0-rc.1` 移进「按声明应当放行」那一侧。

## [0.2.3] - 2026-10-22

### 修复

- **凭据服务里的引擎 Key 曾被静默忽略。** `apply()` 把 `ctx.get("credentials")` 的结果
  捕获成常量，而 credentials 是可选服务、可能比本插件晚激活；晚一步就永远是 undefined，
  用户存在宿主凭据服务里的 `TAVILY_API_KEY` / `EXA_API_KEY` 等从此一律读不到，表现是
  「明明配了 Key 还在走 keyless 额度」。现在每次用到才查。这个缺陷是新增的 HOST-015
  在真实宿主上抓出来的——用假 credentials 的用例看不出激活顺序。

### 新增

- **真实宿主契约用例 HOST-005…022，命令 `npm run check:host`。** 对 staged 宿主把插件
  用到的每一个宿主接口各真调一次：Loader 按 `inject` 激活、`web` 接缝按 id 选中 provider、
  上游 `tool-web` 的 `web_search`、三个工具的裸 JSON Schema 与真实执行、`systemPrompt`
  分区与刷新、`credentials.resolve`、真实 web server 上的三条桥接路由与同源围栏、
  0.2 的 volatile 表单与落盘、0.1 的显式设置分区、revision 冲突、peer 门禁、
  随包客户端模块对真实桥接发真实 HTTP。宿主侧全程不打桩：由宿主自己的 launcher 起一次性
  profile，服务全是真实实例。接口 ↔ 用例逐条对照见 `docs/host-interfaces.md`。
  - 门禁只认 `DSH_HOST_ROOT`（staged 宿主的 `dsh-plugin-desktop` 目录）；没有它时每条
    用例报 `NOT EXECUTED` 且退出码非 0，不会把「什么都没跑」算成通过。
  - 三个 staged 宿主实测：0.2.1-rc.2 17/17、0.2.0-rc.2 17/17、0.1.5-rc.2 16/16，
    另有本代宿主没有该接口的用例显式单列为未执行。
- **空转防护 `scripts/verify-host-contract-mutations.mjs`。** 逐个把被测路径弄坏，要求
  恰好预期的那几条用例变红。实测 0.2.1 与 0.2.0 各 16/16、0.1.5 14/14 全部命中。

### 变更

- **devDependencies 跟到产品锁定的宿主版本。** `@deepseek-ai/dsh-settings` 与
  `@deepseek-ai/dsh-tools` 从 `0.1.0-rc.7` 升到 `0.2.1-rc.2`，`@deepseek-ai/schemastery`
  的范围收到 `^3.18.4`（`Schema.volatile` 的下限）。离线用例因此走 DSH 0.2 设置分支，
  0.1 分支改由 0.1.5-rc.2 真实宿主上的 HOST-019 覆盖。离线夹具同步改成 0.2 形状，
  并把「装上的版本必须等于声明的版本」做成断言，避免悄悄测到产品不发的那一代。

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

[0.2.4]: https://github.com/sobermh/tokens_DshWebSearch_code/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/sobermh/tokens_DshWebSearch_code/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/sobermh/tokens_DshWebSearch_code/compare/v0.2.1...v0.2.2
