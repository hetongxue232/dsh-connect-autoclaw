# atuoclaw — DSH 插件

把本机 **AutoClaw（智谱 zwork）桌面版已登录**的积分额度接成 DeepSeek Harness 的一个模型 provider。
装好即在模型选择器里出现 `atuoclaw` 的模型，**无需填写 API Key、Base URL 或模型参数**。

## 界面：一比一复刻两个参考项目

本插件的浏览器界面按以下两个项目**共同维护的「系列骨架」**一比一复刻，并做足署名：

- [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) — MIT，Copyright (c) 2026 LaoDing
- [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) — MIT，Copyright (c) 2026 LaoDing

两个仓库各有一份 `src/client/series-layout.ts`，首行写明「同系列的公共布局规则，两个桥接插件同步维护此文件」；workbuddy 的 `styles.ts` 也注明关键规则「COPIED FROM dsh-connect-trae, rule for rule」。复刻的是这套**共享骨架**，不是任何一家的功能。

### 复刻清单（逐条对齐）

| 项 | 落法 |
|---|---|
| slot 组合 | `settings.section`(order 30) + 同 id 的 `settings.section.icon`；`conversation.input.right`(order 4) 与 `conversation.composer.dock`(order 10) 双 seat；`conversation.input.model.label`(priority −102)；`main`；`sidebar.panellist`(order 2) |
| 三 surface | page / settings section / legacy 折叠卡 **共用同一份 `cardBody`** |
| 两层 tab | 盒装 chip 的 scope 行 + sticky 下划线分区行（账号 / 模型 / 能力 / 诊断） |
| 数字区 | 3 张 stat 卡（总数 / 到期 / 分钱包），`padding:16px 16px 14px / radius:14px / grid gap:12px` |
| 表格 | grid 表 + 表头 uppercase + 当前行色条；流水表；模型目录表 |
| composer 读数 | 12px 静默触发器 `AutoClaw · 10,232` + 264px portalled 浮层（账户/积分两列表 + 刷新 + 打开面板），`ComposerGate` 按 `modelSelection` 投影的 provider 归属与 seat 决定渲染 |
| 模型标签 | `conversation.input.model.label`，双形状（single/keyed）原子注册，外来 provider 返回纯名字 |
| 度量 | `series-layout.ts` 硬指标：1120px 页宽、tab-cell `8px 12px/radius 10px`、section-tab `7px 11px/13px`、table-row `10px 14px`、`.dsm-btn` `13px/32px`、圆角阶梯 `7/8/10/12/14/999`、字号阶梯 `10/11/12/13/15/20/28` |
| token | 全套 `--dsw-alias-*` 与两个项目相同的 fallback 值 |

### 账号池 / 自动换号 / 导入导出（v2.3.0，按 workbuddy 的规则）

- **账号池默认关闭**——换账号等于换人计费。开启后「先到期的积分先花 → 余额多优先 →
  账号 id 兜底成全序」自动挑号；关闭时严格用你选中的账号
- **自动换号**：每请求最多试 3 个账号。凭据被拒 / 额度没了 / 被限流 / 5xx / 网络错误 → 换；
  400「非法模型」、406 提示词门禁 → 不换（换号只会烧两遍同一个错误）。
  失败账号进 30 分钟冷却；200 头一旦提交绝不重试拼接
- **导入 / 导出**：JSON 文件（含 token，当密码保管），按账号 id 去重合并进插件自己的 vault，
  绝不写回 AutoClaw 的目录
- **签到**：AutoClaw 上游没有签到端点（每日积分自动发放）。账号页如实说明，
  并提供真实存在的**兑换码**接口

### 连通性测试体积（v2.4.0，按 workbuddy 的实测）

上游按**请求体积**限流（~2万 token 过 / ~3万 被拒），小请求「测出可用」但真实长对话被限。
模型页每个模型有「测试」按钮，发**真实体积**请求，三档：

| 档 | input token | 预计积分 |
|---|---|---|
| 小 | 1 万 | ~0.9 |
| 标准（默认，~2.8万） | 2.8 万 | ~2.6 |
| 大 | 5 万 | ~4.6 |

filler 用 workbuddy 实测的中性英文（~4.5 字符/token）；响应回报上游真实
prompt_tokens / total_tokens / 延迟 / 积分估计。结果喂给账号池探针、
档位持久化。AutoClaw 拒绝 `max_tokens`，所以输出靠提示词约束不发该字段。

### 明确不照搬（功能专属，AutoClaw 无对应数据）

企业版·国际版 / 模型勾选草稿 / 思考档 / 文生图 / 促销徽标 / CLI 路线 /
code 11128 救援 / context rescue / OAuth / 设备 SDK。
因此 scope 行是**一个**只读连接态 chip（单账号单 provider），「能力」分区是**只读**的 provider
运行事实，而不是不能保存的开关。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 它怎么拿到凭据（开箱即用的关键，macOS / Windows / Linux）

插件读本机 AutoClaw 桌面版已登录的 `accounts/<账号>/account-credentials.enc`，
按平台分派目录、主密钥与密码学（实测三平台）：

| 平台 | 用户数据根 | 主密钥 | 密文 |
|---|---|---|---|
| macOS | `~/Library/Application Support/AutoClaw-official` | Keychain「AutoClaw Safe Storage」→ PBKDF2(1003) | `v10` AES-128-CBC |
| Windows | `%APPDATA%/AutoClaw-official` | `Local State` 的 `os_crypt.encrypted_key` → DPAPI(CurrentUser) 解 32B | `v10` AES-256-GCM |
| Linux | `$XDG_CONFIG_HOME/AutoClaw-official` | keyring 或 Chromium `peanuts` 兜底 → PBKDF2(1) | `v10`/`v11` AES-128-CBC |

凭据**只读不写**，token 只留在 host 进程内。Windows 的 DPAPI 一步走 PowerShell
（进程内缓存，也支持 `AUTOCLAW_DPAPI_KEY` 显式注入）。目录可用
`AUTOCLAW_USER_DATA_ROOT` 覆盖。签名头用 app 自带 bundle 的常量
（`X-Auth-Appid=100003`、`X-Auth-Sign=md5(appId&ts&appKey)`）。

## 406 的真相

AutoClaw 网关对**系统提示词**做门禁，缺任一项就是空 body 406：
1. system 消息必须包含 `You are AutoClaw. Answer the user directly and concisely.`（containment）
2. 不能带客户端自己的 `max_tokens` / `max_completion_tokens`
3. system 里不能有外来身份短语（`you are claude code` / `you are codex` / `claude agent sdk` / `you are an interactive agent in traecode`）

`src/shim.js` 在转发前逐条满足这三项。认知来源：[eequaled/GLMproxy](https://github.com/eequaled/GLMproxy) 的 `lib/shape.js` 实测记录（MIT）。

## 数据流

```
DSH PiAiAdapter（route: atuoclaw）
  -> loopback shim（随机端口 + 进程内随机 secret，Bearer 校验覆盖所有路由）
  -> https://autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions
```

pi-ai 用 shim secret 作 OpenAI apiKey，shim 常数时间校验后换上真实账号 token。
积分读数走 `/plugins/dsh-connect-autoclaw/{status,ledgers,provider}` 三条只读回环路由。

`package.json` 声明 `engines.dsh: ">=0.1.6-alpha.2 <0.3.0"`（本 bundle 依赖的宿主
API——`registerAdapter`、`webServer.register` exact、slots——按同类插件 dsh-connect-minimaxcode
对宿主包的考据均在 0.1.6-alpha.2 前已存在；实测宿主 0.2.2-rc.3 通过，宿主校验带
`includePrerelease`）。DSH 升到 0.3.0+ 时本插件会被明确拒载并提示，而不是静默出错。

模型表的倍率列显示网关下发的精确值（`creditCostFactor`，如 GLM-5.3 · x4.5），由
目录热刷新自动跟随上游变化；网关没给时回退到档位文案（低/中/高）。

**额度用尽的模型**：网关对某个模型返回 `403 / 810000` 时，插件把它记下来（6 小时 TTL，
写进 vault 的 `state.json`），并**自动回退**——先试 Auto（网关自己的路由器，最不容易
同样没额度），再按目录顺序试其它模型，跳过已知没额度的。回退成功时你只看到能用的回答。
选择器里该模型的名字会带「· 额度已用完」，设置页模型表把它标灰并单独标注。

模型目录另有一条 `/plugins/dsh-connect-autoclaw/catalog`：GET 读当前目录，`?refresh=1`
让宿主**当场**重读网关并重发 `llm/adapters-updated`（模型选择器随即重读），设置页
「模型」区也有同名按钮——**网关侧的模型/窗口变更不再需要重启 DSH**。改插件代码本身
仍是模块级变更：用 `plugin_manager` 工具 `set_bundle dsh-connect-autoclaw` 先
disable 再 enable（live profile 立即生效，无需重启 App），或重启 DSH。

## 实测（本机 macOS，AutoClaw 2.4.2）

| 项 | 结果 |
|---|---|
| 解 safeStorage 凭据 | ✅ |
| 积分 `/agent-assetmgr/api/v2/wallets` | ✅ `total_balance = 13719` |
| 积分流水 `/ledgers` | ✅ 返回真实条目 |
| 模型目录 `/autoclaw-proxy/proxy/autoclaw-model-config` | ✅ 5 个模型 |
| provider 诊断 | `registered:true, shimUrl 非 0, catalogSize:5, catalogError:""` |
| shim 端到端非流式 | ✅ 200 `PONG` |
| shim 端到端流式 SSE | ✅ 200，`[DONE]` 收尾 |
| 错误 secret / 无 secret | ✅ 401（覆盖 `/v1/models`） |
| 伪造 Host（DNS rebinding） | ✅ 403 |
| 真实网关探针（`POST /probe`） | ✅ `outcome:ok`，2.8s |
| 11 条浏览器路由 Host/Origin 校验 | ✅ 全覆盖 |
| MCP `tools/call` 三个工具 | ✅ 真实数据 |
| 78 个单元测试（真机 + 无 AutoClaw 的干净 HOME） | ✅ 全通过 |
| client 组件树（7 slot / 三 surface / 4 面板 / Gate / ModelLabel） | ✅ stub React 验证 |

## 安装

从 GitHub 克隆后，二选一：

```bash
git clone https://github.com/hetongxue232/dsh-connect-autoclaw.git
```

1. **DSH 插件管理器**：`plugin_manager action=install_bundle target=<克隆目录绝对路径>`；
   或图形界面「插件 → 添加插件 → 本地目录」。
2. **直接用源码**：把目录放到 `~/.dsh/vendor/` 下，然后 `set_plugin` 指向它。

`list_plugins` / `set_plugin` 用 `include:dsh-connect-autoclaw` 作为 target。

前置条件：本机已安装并登录 AutoClaw 桌面版。插件**只读**它自己的 safeStorage 凭据，
不写入、不上传。

### 跑测试

```bash
node --test             # 78 个测试，无需登录、无需联网（不要带目录参数）
```

每个测试文件也可单独执行：`node test/shim.test.js`。

### 自检

装好后打开 DSH，模型选择器里出现 `atuoclaw` 即成功；装失败时看
`/plugins/dsh-connect-autoclaw/provider` 的 `registered` / `error` 字段。

## MCP 用法

`mcp/server.mjs` 是同一套只读接口的 MCP stdio 版本，供 AutoClaw 自己的 agent 调用：

```bash
node <克隆目录>/mcp/server.mjs
```

三个工具：`autoclaw_points` / `autoclaw_expiring` / `autoclaw_ledger`。详见 [docs/MCP.md](docs/MCP.md)。

## 致谢与许可

见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目自身 MIT。
上游 406 门禁认知来自 GLMproxy；provider 装配形状参考 dsh-connect-zhipu；
界面骨架与度量来自 dsh-connect-trae + dsh-connect-workbuddy（均为 MIT）。
