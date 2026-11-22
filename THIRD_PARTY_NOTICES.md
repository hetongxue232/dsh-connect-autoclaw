# 第三方开源声明（Third-Party Notices）

> 记录本项目在设计与实现上参考或借鉴的开源项目、各自许可证，以及**具体借鉴了哪一段**。
> 通用平台依赖（`@deepseek-ai/*`、`react`、`@earendil-works/pi-ai` 等）的许可证随各自 npm 包携带，不在本文档范围。

## 一、界面来源：两个项目共同维护的「系列骨架」

本插件的浏览器界面是 **dsh-connect-trae 与 dsh-connect-workbuddy 共同骨架的一比一复刻**。
两个仓库各自保留一份 `src/client/series-layout.ts`，文件首行写明「同系列的公共布局规则，两个桥接插件同步维护此文件」；
`dsh-connect-workbuddy/src/client/styles.ts` 里也注明关键规则「COPIED FROM dsh-connect-trae, rule for rule」。

| 角色 | 项目 | 提供了什么 |
|---|---|---|
| 界面骨架基准 | [`dsh-connect-trae`](https://github.com/dingminhua/dsh-connect-trae) | slot 组合、三 surface 共用一份 `cardBody`、两层 tab（盒装 chip + sticky 下划线）、stat 卡、grid 表、诊断行、`dsm-btn`、composer 双 seat + Gate、model.label 负优先级、`--dsw-alias-*` token 全套 fallback |
| 界面骨架基准 | [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) | 与 trae 同步的 `series-layout.ts`（1120px 页宽、`max-width` 覆盖 trae 的 860）、`ComposerCredits` / `ComposerCreditsGate`、portalled popover、`model-label-seat.ts`、`settings-jump`、locale 1:1 键结构、`.dsm-workbuddy-usage` 卡片网格 |
| 外观的更早源头 | [`dsh-subagent-default-model`](https://github.com/dingminhua/dsh-subagent-default-model) | `dsm-*` CSS 与 `row.*` 文案键约定（经 trae 转引） |
| 连接内核参照 | [`dsh-connect-zhipu`](https://github.com/dingminhua/dsh-connect-zhipu) | loopback shim（随机端口 + 进程内随机 secret）+ `PiAiAdapter` 的装配形状、`foldModernContext` 的 1.x seam 处理、`toPiModel` 的字段 |
| 连接内核参照 | [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT, Copyright (c) 2026 Corrine Hu） | 凭据发现 → 上游协议 → loopback 路由 → provider 装配这条链路的分层方式（经 workbuddy 转引） |
| 上游协议参照 | [eequaled/GLMproxy](https://github.com/eequaled/GLMproxy)（MIT） | `lib/shape.js` 的 406 实测记录：系统提示词白名单/黑名单、`max_tokens` 门禁——本插件 `src/shim.js` 的 `REQUIRED_BANNER` / `FOREIGN_IDENTITY_PHRASES` / `translateRequest` 来自这里 |
| 上游协议参照 | [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT） | 上游鉴权头组织方式的对照样本（经 workbuddy 转引） |

## 二、许可证

| 项目 | 许可证 |
|---|---|
| `dsh-connect-trae` | **MIT**（Copyright (c) 2026 LaoDing） |
| `dsh-connect-workbuddy` | **MIT**（Copyright (c) 2026 LaoDing；部分实现注明参考 corrinehu/dsh-workbuddy-connect） |
| `dsh-subagent-default-model` | **MIT**（Copyright (c) 2026 LaoDing） |
| `dsh-connect-zhipu` | **MIT** |
| `dsh-workbuddy-connect` | **MIT**（Copyright (c) 2026 Corrine Hu） |
| `eequaled/GLMproxy` | **MIT** |
| `Sliverkiss/workbuddy2api` | **MIT** |

### MIT 义务说明

上述 MIT 项目的版权声明与许可声明均予保留。本文件即为归集；各项目完整 LICENSE 见其仓库。
本插件**未复制粘贴源码文件**，而是按其验证过的决策与度量独立重写：CSS 类名统一改前缀为
`dsm-autoclaw-`、组件名改本插件命名、逻辑按 AutoClaw 单账号单 provider 的现状重新实现。

## 三、实际使用方式：借鉴结构与数值，独立实现逻辑

- `client.js` 的 slot 清单、三 surface、两层 tab、stat 卡、grid 表、诊断行、composer 双 seat +
  Gate、model.label 的 `modelLabelSeats` 形状，全部按两个项目的共同骨架重写；CSS 数值
  （1120px 页宽、tab-cell `8px 12px` / `radius 10px`、section-tab `7px 11px` / `13px`、
  table-row `10px 14px`、`.dsm-btn` `13px/32px`、composer 触发器 `12px`、popover `264px`、
  `MODEL_LABEL_PRIORITY = -102`、圆角阶梯 `7/8/10/12/14/999`）逐条对齐 `series-layout.ts`。
- `--dsw-alias-*` token 的 fallback 值（`#e6e6e6 / #c6c9d0 / #999 / #36373b / #3a3d45 /
  #24262c / #232529 / #202126 / #2a2c33 / #5686fe / #22c55e / #f59e0b / #ef4444 / #e8b34b`）
  与两个项目一致。
- `src/shim.js`、`src/adapter.js`、`src/credential.js`、`src/upstream.js` 针对 AutoClaw 自己的
  凭据格式、签名头与 406 门禁独立实现，没有对应的上游实现可抄。
- v2.5.0 的 Windows（DPAPI + AES-256-GCM）/ Linux（`peanuts` + `v11`）/ 目录探测
  认知来自 GLMproxy 的 `lib/vault.js`（MIT，实测三平台）；PowerShell
  `ProtectedData::Unprotect` 的调用形状按其最终结论实现。
- 未引入任何新依赖。

## 四、明确「没有照搬」的部分（功能专属，AutoClaw 无对应数据）

| 不移植 | 归属 | 原因 |
|---|---|---|
| 企业版 / 国际版 / 多地区 tab | trae | 只有一个 provider 路由 `atuoclaw`；故 scope 行**一个** chip，而非伪造三选一 |
| 模型勾选草稿 / Save-Discard / 一键测试 / 思考档 / 文生图 / 上下文预算 / 促销徽标 | trae | 模型目录只读 |
| CLI 路线 / CodeBuddy 回合 pill / code 11128 救援 / context rescue / OAuth / 设备 SDK | workbuddy | 与 AutoClaw 上游无关 |
| `shell.quota-notice` 占位 | workbuddy | 没有额度 Toast 需要交还宿主 |
| 能力分区的开关组 | 两者 | 改为**只读**的 provider 运行事实（路由 / 网关 / shim / 注册状态 / 门禁 / 模型数） |
| 每日签到 | trae | **AutoClaw 上游没有签到端点**（bundle 全量检索确认）；流水里的每日积分是自动发放。账号页如实说明，并提供上游真实存在的兑换码接口替代 |

v2.3.0 起账号池 / 自动换号 / 账号导入导出已按 workbuddy 的规则实现（见
`docs/DETAIL.md` 的「账号池」一节）：双来源（app 目录只读 + 插件 vault）、
池默认关闭、先到期先花、失败分类决定换不换号、30 分钟探针冷却。

「能力」分区保留分区位置与诊断行形态，但内容是只读事实而非可写开关——一个不能保存的开关比没有更糟。

## 五、与参考项目的关键差异（必读）

参考项目是**多账号 / 多区域供应商连接器**；本插件是**单账号零配置连接器**：

- 凭据来自本机 AutoClaw 桌面版的 `safeStorage` 登录态（只读），不要求用户填任何 Key；
- 注册**一个** provider 路由 `atuoclaw`，loopback shim 持有真实账号 token；
- 上游 `/autoclaw-proxy/proxy/autoclaw/chat/completions` 的系统提示词门禁由 shim 在转发前
  逐条满足（补 banner、中和外来身份短语、删 `max_tokens`）——这一层是 AutoClaw 独有的，
  两个参考项目都没有；
- 早期 1.0 版本「不注册 provider、只做读数」的结论已被推翻，见 `docs/DETAIL.md`。
