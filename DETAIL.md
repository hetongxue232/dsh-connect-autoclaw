# atuoclaw

把本机 AutoClaw（智谱 zwork）桌面版**已登录**的积分额度，接成 DSH 的一个模型 provider。

装好之后在模型选择器里就能看到 `atuoclaw` 的模型，**不需要填 API Key、Base URL 或模型名**。积分余额与到期提醒同时显示在输入框旁边的读数里。

## Windows / Linux 支持（v2.5.0）

`src/credential.js` 现在按 `process.platform` 分派目录、主密钥与密码学，
不再把 macOS 写死：

| 平台 | 用户数据根目录（按序探测） | 主密钥 | 密文 |
|---|---|---|---|
| macOS | `~/Library/Application Support/AutoClaw-official`、`AutoClaw`、`AutoClaw-oversea-official` | Keychain「AutoClaw Safe Storage / AutoClaw Key」→ PBKDF2-SHA1(1003) | `v10` AES-128-CBC，IV=16 空格 |
| Windows | `%APPDATA%/…`（同上三个目录名） | `<root>/Local State` 的 `os_crypt.encrypted_key` 经 **DPAPI(CurrentUser)** 解出 32B | `v10` AES-256-GCM，12B nonce + 16B tag |
| Linux | `$XDG_CONFIG_HOME/…` 或 `~/.config/…` | Secret Service 空位时用 Chromium 的 `peanuts` 兜底，PBKDF2-SHA1(1) | `v10`/`v11` AES-128-CBC，IV=16 空格 |

三者都用 `v10` 前缀，所以**由平台而非前缀选择 cipher**。DPAPI 那一步 Node 没有原生
绑定，用一次 PowerShell `ProtectedData::Unprotect`（进程内缓存；显式
`AUTOCLAW_DPAPI_KEY` 可直接给 32B base64 供 headless 用）。`Local State` 路径走
环境变量传入脚本，避免命令行路径 quoting。

同步修掉的硬编码：`src/accounts.js` 的 `listAccounts()` 改用 `accountsRoot()`、
`src/upstream.js` 的 `readDeviceId()` 从 `accountsRoot()` 反推配置根（不再是
`~/Library/...`）、`vaultRoot()` 增加 `AUTOCLAW_VAULT_DIR` 覆盖。可用环境变量：
`AUTOCLAW_USER_DATA_ROOT` / `AUTOCLAW_CONFIG_DIR`（目录）、
`AUTOCLAW_KEYRING_PASSWORD`（Linux）、`AUTOCLAW_DPAPI_KEY`（Windows）、
`AUTOCLAW_VAULT_DIR`（插件 vault）。

凭据格式来自 [eequaled/GLMproxy](https://github.com/eequaled/GLMproxy) 的
`lib/vault.js`（MIT，实测过三平台）。测试用 `node:crypto` 造真实密文做了三平台
round-trip（含错误 key / 篡改 tag / v11 在 macOS 被拒 / 目录解析），40 个测试全过。

## 它怎么拿到凭据

插件读 AutoClaw 自己的登录态，不问你任何东西：

```
~/Library/Application Support/AutoClaw-official/accounts/<账号>/account-credentials.enc
  → Keychain「AutoClaw Safe Storage / AutoClaw Key」拿主口令
  → PBKDF2-SHA1(saltysalt, 1003 轮) → AES-128-CBC 解 v10 密文
  → accessToken
```

然后用这个 token 配上 AutoClaw 自己的请求签名
（`X-Auth-Sign = md5(appId & 秒级时间戳 & appKey)`，常量取自 app 自带 bundle），
去调它的网关。

**凭据只读不写。** 插件不碰 AutoClaw 的任何文件，token 刷新只留在这个进程内存里。

## 上游要求的三件事（1.0 就是卡在这里）

AutoClaw 的网关对**系统提示词**做门禁。缺任何一项都会得到一个**空 body 的 406**：

1. `system` 消息里必须**包含**这句：

   ```
   You are AutoClaw. Answer the user directly and concisely.
   ```

   匹配方式是 containment（前面加料也过，缺了这句就拒），而且**只扫 system 消息**——
   同一句话放在 user 轮次里是能过的。

2. 不能带客户端自己的 `max_tokens` / `max_completion_tokens`。
3. system 里不能有外来客户端身份短语：`you are claude code`、`you are codex`、
   `claude agent sdk`、`you are an interactive agent in traecode`。

插件在 loopback shim 里逐条满足这三项再转发。除此之外它就是个普通的
OpenAI Chat Completions 客户端 —— 上游的协议本来就是 OpenAI 兼容的。

## 模型选择器为什么一开始是空的（v2.2.2 修）

`modelCatalog()` 的链路是 `listProviders()` → `listModels(provider)`，而它是在
`registerAdapter` 发布 `llm/adapters-updated` 的那一刻被 GUI 拉取的。早期的
`catalogCache` 初始为空、由一次异步网关请求填充，于是 GUI 读到 0 个模型，
该分组被 `groups.filter(models.length > 0)` 丢掉——provider 明明注册成功，
选择器里却没有模型。

修法与两个参考项目一致，补齐「三件套」并给目录一个同步种子：

1. `registerAdapter([...])` —— 请求路由
2. `registerConfigurableProviders([...])` —— 可配置供应商目录（设置页能寻址）
3. `registerModelDiscovery(settingsNs, ...)` —— 模型发现
4. `FALLBACK_MODELS` —— 注册瞬间即可读的 5 个模型（网关真实目录），
   异步拉取成功后整体替换，并 `registration.replace()` 重新发布事件让 GUI 重读

诊断路由会回报宿主服务真实的 `listModelsCount` / `listModelsIds`，不靠猜。

## 账号池 / 自动换号 / 导入导出（v2.3.0）

参照 `dsh-connect-workbuddy` 的账号池（改成本插件的单 provider 形态）：

- **两个账号来源**：本机 AutoClaw 的账号目录（只读）+ 插件自己的 vault
  （`$DSH_HOME/atuoclaw-vault/`，导入的账号住这里，绝不写回 app 的目录）。
- **账号池默认关闭**：换账号等于换人计费，只能由你点头。开启后按
  「先到期的积分先花 → 余额多优先 → 账号 id 兜底成全序」自动挑号；
  关闭时严格使用你选中的账号。
- **自动换号**：shim 里每请求最多试 3 个账号。失败分类决定要不要换——
  401 / 410000（凭据被拒）、810000（该账号额度没了）、810002（该账号被限流）、
  5xx / 网络错误 → 换；400「非法模型」、406（提示词门禁）→ 不换，换号只会
  把同一个错误烧两遍。失败账号进入 30 分钟冷却（workbuddy 的值），期间池
  不再选它；成功会清掉旧的冷却记录。一旦 200 头已提交，答案原样流式——
  绝不重试拼接两段回答。
- **导入 / 导出**：导出是一份 JSON 下载（含 accessToken，当密码保管）；
  导入按账号 id 去重合并进 vault，缺 token 的记录跳过并计数。
- **签到：AutoClaw 没有这个接口。** 流水里的「新用户积分发放（第 1/7 天）」
  是自动到账，上游没有可调用的 check-in 端点（翻遍了 bundle）。账号页如实
  说明这一点，并提供上游**真实存在**的兑换码接口
  （`POST /agent-assetmgr/api/v1/autoglm-codes/redeem`）作为替代。

## 积分消耗过快：反代无关，根因是 agentic loop × 全历史重放 × 按 total 计费（v2.3.2 修）

对账结论（2026-11-14 凌晨，流水 + app 双日志比对）：

- **不是反代重发**。流水里 21 笔大额扣费的 `request_id` 在本机 app 日志里全部不存在，
  且没有任何重复 `request_id`；shim 是一进一出的透明转发。
- **不是签到/兑换**。窗口内另有小额 `agent-dr open/search usage`（各 6 积分），
  是 AutoClaw app 自身的 DR 工具调用，量小。
- **真正原因**：DSH 的 agentic loop 每个 step 都把**完整会话历史**重放给模型。
  那个开发会话的历史涨到 ~59 万 token 后，turn16 的每一步都重放它，而网关按
  `total_tokens`（含 99.9% 的 cached）计费：单价 ≈ 9.2e-8 积分/token，
  59 万 token ≈ **54 积分/步**。turn16 共 53 步 ≈ **2800 积分/回合**。
- app 日志侧 15 条小额记录（total 1.5万~3.5万，-1~-4 积分）与流水一一对应，
  证明记账逻辑一致，只是主体的会话历史大小不同。

**修法（不动上游，改插件自己声明的预算）**：`compaction-basic` 只在历史超过
`min(contextWindow × 0.8, contextWindow − maxTokens)` 时才压缩。网关广告
1M/131072 → 阈值 ~83.9 万 token，太晚。插件现在把目录里的 contextWindow /
maxTokens 钳到 **131072 / 16384**（fallback 表与 `fetchCatalog` 两处一致），
压缩阈值降到 **~10.5 万 token ≈ 10 积分/步**，且每步的 completion 预留也更小。

**风险**：131072 只是宿主侧的「预算声明」，上游实际仍接受更大上下文——压缩
提前发生意味着长会话更早丢细节（ retain 保留尾部 ~1.8 万 token）。如果某个
任务真的需要 59 万上下文，它现在会被切成多次压缩摘要而非一次直传。

## 连通性测试的请求体积（v2.4.0）

参照 `dsh-connect-workbuddy` 的实测结论：**上游按请求体积限流**（约 2万 token 能过、
约 3万 token 被拒），一个只发几十 token 的 ping 会「测出可用」而真实长对话一发就被限。
因此模型页的「测试」按钮发的是**真实体积**请求，filler 沿用 workbuddy 实测的中性英文
（`The quick brown fox jumps over the lazy dog. `，约 4.5 字符/token）。

三档（默认标准）：

| 档位 | input token | 预计积分 | 用途 |
|---|---|---|---|
| 小 | 1 万 | ~0.9 | 积分紧张时快速验证连通性 |
| 标准 | 2.8 万 | ~2.6 | 覆盖默认会话体积、能触发限流逻辑 |
| 大 | 5 万 | ~4.6 | 长对话用户，测得最准 |

积分估计来自流水实测单价（55 积分 / 599,014 total token ≈ 9.2e-5 积分/token），
响应里回报**上游真实的 prompt_tokens / total_tokens / latencyMs / pointsEstimate**，
不靠猜。两处 AutoClaw 专属约束：

- 上游拒绝客户端 `max_tokens`（空 body 406），所以输出上限靠提示词
  「Reply with a single word.」约束，不发该字段
- system 消息必须带 `REQUIRED_BANNER`（`translateRequest` 保证且不会重复）

测试结果同时喂给账号池探针记录：可 failover 的失败给该账号打 30 分钟冷却标记；
成功清掉旧标记；400/406 这类「请求本身」失败不记账号。档位持久化进 vault，
刷新页面不跳回默认。

## 数据流

```
DSH PiAiAdapter（route: atuoclaw）
  -> loopback shim（随机端口 + 进程内随机 secret）
  -> https://autoglm-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions
```

pi-ai 用 shim 的随机 secret 作为 OpenAI apiKey，shim 常数时间校验它，
然后把真实账号 token 换上去。**secret 不出本进程，token 只到厂商网关。**

## 面板

- 输入框旁的读数：积分总额，点开看分钱包、到期明细与最近流水
- 到期提醒按紧急度分级：超过 24 小时用普通提示，24 小时内升成警告

## 限制

- **需要本机装有 AutoClaw 桌面版并登录过。** 没装或没登录，面板会直说，
  模型路由也会在第一次调用时明确报「凭据不可用」
- 只在 **macOS** 上验证过。解密依赖 macOS 自带的 `security` 与 `openssl`；
  Windows 走 DPAPI、Linux 走 `v11` + 固定口令，需要另写那一层
- `zaicoding_glm-5.3` 这个模型走的是 AutoClaw 的会员额度，免费额度用完后
  网关返回 403「GLM-5.3 免费额度已用完」。这是额度问题，不是插件问题；
  `zai_glm-5.3-flash`、`zai_auto`、`zai_auto-fast` 用的是积分
- 上游若改了那句白名单措辞，插件会重新开始 406。届时改
  `src/shim.js` 的 `REQUIRED_BANNER` 常量即可

## 实测（本机 macOS，AutoClaw 2.4.2）

| 项 | 结果 |
|---|---|
| 解 safeStorage 凭据 | ✅ |
| 积分 `/agent-assetmgr/api/v2/wallets` | ✅ `total_balance = 10246` |
| 模型目录 | ✅ `zai_auto`、`zai_auto-fast`、`zaicoding_glm-5.3`、`zai_glm-5.3-flash`、`zai_glm-5.3-flashx-legal` |
| shim 端到端（裸请求，无 system） | ✅ 200，流式返回「流式」 |
| shim 端到端（带外来身份短语 + max_tokens） | ✅ 200，三个门禁都被改写 |
| 错误 secret | ✅ 401 |
| 不存在的模型 | ✅ 400 `非法模型`（上游原文透传） |

## 界面来源

浏览器界面是 [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) 与
[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 共同维护的
「系列骨架」的一比一复刻（均为 MIT，Copyright (c) 2026 LaoDing）：slot 组合、
三 surface 共用一份 `cardBody`、两层 tab、stat 卡、grid 表、composer 双 seat + Gate、
model.label 负优先级，以及 `series-layout.ts` 的逐条度量。
功能专属部分（账号池 / 签到 / 多地区 / CLI 路线 / 救援）未移植。
完整署名与「不照搬」清单见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 致谢

- [eequaled/GLMproxy](https://github.com/eequaled/GLMproxy)（MIT）——
  `lib/shape.js` 的 406 实测记录，本插件的提示词门禁认知来自这里
- [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)（MIT）——
  界面骨架与度量
- [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）——
  界面骨架与度量、错误分类「业务码优先于 HTTP 状态」
- [dingminhua/dsh-connect-zhipu](https://github.com/dingminhua/dsh-connect-zhipu)（MIT）——
  loopback shim + PiAiAdapter 的装配形状
