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
| 积分 `/agent-assetmgr/api/v2/wallets` | ✅ `total_balance = 10232` |
| 模型目录 `/autoclaw-proxy/proxy/autoclaw-model-config` | ✅ 5 个模型 |
| provider 诊断 | `registered:true, shimUrl 非 0, catalogSize:5, catalogError:""` |
| shim 端到端（裸请求 / 外来身份短语 + max_tokens / 非流式） | ✅ 200 |
| 错误 secret / 无 secret | ✅ 401（覆盖 `/v1/models`） |
| 不存在的模型 | ✅ 400 上游原文透传 |
| 15 个单元测试 | ✅ 全通过 |
| client 组件树（7 slot / 三 surface / 4 面板 / Gate / ModelLabel） | ✅ stub React 验证 |

## 性能：四项优化与 A/B 基准（v2.6.0）

反代的延迟由四层决定，四层各自独立可测。以下数据全部来自本机对**真实上游**的实测，
脚本在 [`benchmarks/`](benchmarks/)，原始采样在同目录，可复现。

### 改了什么

| # | 项 | 改动前 | 改动后 |
|---|---|---|---|
| ① | 账号并发门 | 每账号**严格串行**（同时只允许 1 个请求） | 有界并发窗口，默认 `maxConcurrentPerAccount: 4` |
| ② | 上游连接 | 每请求新建 TCP+TLS | `node:https` keep-alive 连接池（16 sockets） |
| ③ | 超时 | 单一 285 s | **首包 30 s**（可 failover）+ **总 285 s** |
| ④ | 429/5xx | 只换账号，不记模型 | 连续 2 次即降权，指数退避 60s→120s→…→15min 上限 |

### 结果（`zai_auto`，流式，真实网关）

| 并发 | 改造前 TTFB p50 | 改造后 p50 | 变化 | 吞吐 |
|---|---|---|---|---|
| 4 | 4331 ms | **1293 ms** | **−70%** | 0.36 → 0.54/s |
| 8 | 13625 ms | **2722 ms** | **−80%** | 0.27 → **1.25/s** |

成功率 36/36，超时 0%，错误 0%。

### 关键教训：不要拿历史数字比

单发（并发 1）曾记录到 623 ms，优化后测出 928 ms，看上去"退化了 49%"。
**这是测量伪影**。给 harness 加 `--legacy` 后，用**同一份代码**重跑两遍各 20 次：

| 配置 | min | p25 | **p50** | p75 | p90 | max | mean |
|---|---|---|---|---|---|---|---|
| legacy（窗口1，无连接池） | 812 | 903 | **986** | 1234 | 1797 | 4437 | 1236 |
| 优化后（窗口4，连接池） | **646** | 846 | **937** | 1237 | 2559 | 3118 | 1197 |

优化后 p50 实际**快 5%**，`min` 快 20%（省掉一次 TLS 握手）。单发时窗口宽度不参与，
收益只来自连接池。历史 623 ms 是一次幸运样本，而上游自身波动 ±60%（实测散布
623–1489 ms），**跨时段比较没有意义**。

### 复现基准

```bash
# 1. 起一个独立 shim（与生产同一份代码，自建 secret，另开诊断端口）
node benchmarks/shim-harness.mjs --window 4 --interval 400
#    → {"chat":"http://127.0.0.1:PORT","token":"...","diag":"http://127.0.0.1:PORT2","window":4}

# 2. 压测（把 chat/token 填进去）
node benchmarks/bench.mjs --base <chat> --token <token> \
  --model zai_auto --concurrency 8 --rounds 3 --stream --out result.json

# 3. 边压测边采样窗口占用（需要 --diag）
node benchmarks/bench-with-sampler.mjs --base <chat> --diag <diag> --token <token> \
  --model zai_auto --concurrency 8 --rounds 3 --interval-ms 150 --out curve.json
```

**`--legacy` 是 A/B 的关键**：它把窗口压回 1 并关掉连接池，跑的是同一份新代码的旧行为。

```bash
node benchmarks/shim-harness.mjs --legacy --interval 400   # 对照组的传统模式
node benchmarks/shim-harness.mjs --window 4 --interval 400 # 优化组
```

### 指标口径（口径不一致就没法比）

| 指标 | 定义 |
|---|---|
| TTFB | 发出 POST → 收到**第一个非空 body 字节**。SSE 下即首个 `data:` 帧 |
| TTFT | 首个含 `delta.content` / `delta.reasoning_content` 的帧（仅流式） |
| timeout | 在 deadline 内既无响应头也无数据 |
| error | 非 200，或 200 但 body 无 `choices` / `data:` 帧 |
| 采样 | 每档 `rounds × concurrency` 个请求；百分位用**最近秩法** |

测试环境：macOS 15.8 arm64，Node v24.21.0，单账号，loopback 连
`https://autoglm-api.zhipuai.cn`，2026-11-23 00:2x CST。

### 原始数据

| 文件 | 内容 |
|---|---|
| [`benchmarks/legacy-concurrency1-20x.json`](benchmarks/legacy-concurrency1-20x.json) | A/B 对照组，20 次逐条 TTFB |
| [`benchmarks/optimized-concurrency1-20x.json`](benchmarks/optimized-concurrency1-20x.json) | A/B 优化组，20 次逐条 TTFB |
| [`benchmarks/baseline-concurrency4.json`](benchmarks/baseline-concurrency4.json) | 改造前并发 4 |
| [`benchmarks/baseline-concurrency8.json`](benchmarks/baseline-concurrency8.json) | 改造前并发 8 |
| [`benchmarks/optimized-concurrency4.json`](benchmarks/optimized-concurrency4.json) | 改造后并发 4 |
| [`benchmarks/optimized-concurrency8.json`](benchmarks/optimized-concurrency8.json) | 改造后并发 8 |

### 已知边界

- 单发收益有限（−5%）：上游首包本身 600–900 ms，连接池只省握手那 ~150 ms。
- 并发 8 时窗口 4 仍是瓶颈（`saturated` 约 50–60%）。放大窗口会把排队转移到网关，
  可能触发限流——调 `maxConcurrentPerAccount` 前先看 `/provider` 的 `limiter.saturated`。
- 只测了 `zai_auto`。其他模型的上游延迟未采样。

## 安装

`plugin_manager action=install_bundle target=<本目录绝对路径>`，或 DSH「插件 → 添加插件 → 本地目录」。
`list_plugins` / `set_plugin` 用 `include:dsh-connect-autoclaw` 作为 target。

## 致谢与许可

见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目自身 MIT。
上游 406 门禁认知来自 GLMproxy；provider 装配形状参考 dsh-connect-zhipu；
界面骨架与度量来自 dsh-connect-trae + dsh-connect-workbuddy（均为 MIT）。
