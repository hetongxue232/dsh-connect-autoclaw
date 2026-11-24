# Changelog

## 2.6.3 (2026-11-24)

修复两个把「网关繁忙」报成「API 密钥无效」的路径。

### ① `810001` 未分类

`810001` 是 AutoClaw 的**过载**应答（「当前使用人数较多，系统繁忙，请稍后重试」），
和额度耗尽一样以 **403** 到达。旧分类表里没有它，落到 `request`：

- `request` 不可 failover → 换个账号本可以成功的请求直接失败；
- 403 原样透传 → DSH 的 `classifyPiAiError` 命中 `403` → **AUTH** → 「API 密钥无效」。

修复：`810001` 归入 `rate`（可 failover），应答改为 **503 / `upstream_overloaded`**，
并在消息里加 `rate limited` 关键词供 DSH 归类。

### ② 单账号耗尽伪造 401

单账号时，failover 第一轮就把该账号放进 `exclude`，第二轮必然取不到账号，
于是报：

```
401 no further AutoClaw account after 1 failure(s): 9b4eb4f2…
```

这条 401 把**上游真实原因整个抹掉**，DSH 判成 AUTH 显示「API 密钥无效」。
实测会话里 16:20:19 / 16:20:30 两次都是这个形态，真实原因是 810001。

修复：记住本轮最后一次上游失败；当账号池耗尽时**重放那次失败**（402/503/原状态），
只有「从头就没有账号」才保留 401 的 sign-in 提示。

### 验证

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 810001 繁忙 | 403 → AUTH「密钥无效」 | **503 `upstream_overloaded`** |
| 单账号耗尽 | 401「no further account」 | **503，保留上游原文** |
| 810000 额度 | 403 → AUTH | 402 `insufficient_quota`（2.6.2） |

分类表逐条验证：`810000→quota`、`810001→rate`、`810002→rate`、`401→credential`、
`403→credential`、`5xx→server`、`400→request`，且前三者 `failover=true`。

### 测试

新增 2 条回归测试（810001 → 503 且不含 401/403 字面量；单账号耗尽重放真实失败）。
总计 **118/118**。版本 2.6.2 → **2.6.3**，build → `2026-11-24-overload-and-pool`。

## 2.6.2 (2026-11-24)

修复「额度用完」被显示成「API 密钥无效」。

### 根本原因

DSH 的 `classifyPiAiError` 用正则从**错误消息**里抓 `401|403` 判为 `AUTH`：

```js
const LEADING_HTTP_STATUS = /^[45]\d\d\b/
if (/\b(?:401|403)\b/.test(statusSource)) return "AUTH"   // → UI「API 密钥无效」
```

而 AutoClaw 对额度耗尽正是返回 **403** + `{"code":810000,"message":"…额度已用完…"}`。
插件原样透传 403，于是 DSH 判成 AUTH，用户看到「API 密钥无效」——真正原因是
GLM-5.4 的免费额度用完了。

雪上加霜：DSH 的 `isQuotaExceededError` 只认英文关键词
（`insufficient quota` / `quota exceeded` 等），上游消息是中文，一条也匹配不上，
所以连兜底都失败了。

### 修复

额度类失败改答 **402（Payment Required）**，并在消息前加英文 quota 关键词：

```
HTTP 402
{"error":{"type":"insufficient_quota",
          "message":"insufficient quota: quota exhausted for model zai_glm-x-preview —— …"}}
```

- 402 语义正确，且不含触发误判的 `401/403` 字面量；
- 英文关键词让 `isQuotaExceededError` 命中，DSH 分类为 `QUOTA`；
- 中文原文完整保留在消息尾部，用户仍能看到上游原话。

### 验证

| 项 | 修复前 | 修复后 |
|---|---|---|
| HTTP 状态 | 403 | **402** |
| DSH 分类 | `AUTH` → 「API 密钥无效」 | **`QUOTA`** |
| 消息 | 仅中文 | 含 `insufficient quota` |

### 测试

新增回归测试断言三点：状态必须是 402 而非 403、type 为 `insufficient_quota`、
消息含英文关键词且**不以 401/403 开头**。旧测试中把 403 写死的断言同步更新。
总计 **116/116**。

## 2.6.1 (2026-11-24)

修复 2.6.0 引入的一个**严重回归**：用户选的模型被静默改写成 Auto。

### 根本原因

2.6.0 给 shim 补上了 `initialModel` 钩子（此前 `shim.js` 一直在调用、`index.js` 从未实现），
但实现写成了 `chainFor(requested)[0]`。而 `fallbackChain` 的**设计**是把 preferred
（`zai_auto`）排在最前——所以 `chain[0]` 永远是 Auto：

```
chainFor('zai_glm-x-preview')
  = zai_auto -> zai_glm-x-preview -> zai_auto-fast -> ...
    ^^^^^^^^ 首次尝试被改写成它
```

后果：**选择器里选任何模型都无效**，请求永远发往 Auto。实测表现为「选 GLM-5.4，
连发三次，三次都回 `by zai_auto`，GLM-5.4 上游命中 0 次」——而且因为 GLM-5.4
从未被真正调用，健康记录永远是空的，降权逻辑形同虚设。

### 修复

`initialModel` 只在请求的模型**已被记录为不可用**时才改写：

```js
initialModel: (requested) => {
  const unavailable = isQuotaExhausted(state.quota, requested)
    || demotedModels(state.modelHealth).includes(requested)
  if (!unavailable) return requested        // 尊重用户选择
  return chainFor(requested)[0]             // 已知不可用才换
}
```

### 修复后的实测（GLM-5.4 对网关返回 429）

| 请求 | GLM-5.4 上游命中 | 结果 |
|---|---|---|
| 第 1 次 | **2 次**（两次 429 达阈值 → 降权） | 回退 Auto 返回 200 |
| 第 2 次 | **0 次** | 直接走 Auto，不再浪费请求 |
| 第 3 次 | **0 次** | 同上 |

选择器标签正确显示 `zai_glm-x-preview · 暂时不可用`。

### 测试

新增 5 条回归测试（`test/model-health.test.js`）固定该规则：健康的选择不被改写、
降权的被替换、耗尽的被替换、冷却过期后恢复尊重、preferred 自身直通。
总计 **115/115**。

### 顺带确认

网关已新增 **GLM-5.4**（id `zai_glm-x-preview`，name `GLM-5.4`，窗口 1,048,576，
max 307,200，倍率 x2.25）。插件**无需改代码**即可识别——目录不硬编码、窗口直通、
倍率透传、支持 `?refresh=1` 热刷新，这几项设计在此得到验证。

## 2.6.0 (2026-11-23)

反代性能四连改。全部基于对**真实上游**的实测，脚本与原始采样随包发布在 `benchmarks/`。

### 改动点

**① 账号并发门：串行 → 有界并发窗口**（`src/ratelimit.js` 重写）

- 旧行为：每账号同时只允许 1 个请求，后来者排队等前一个的**完整响应**（队头阻塞）。
- 新行为：`maxConcurrentPerAccount`，默认 **4**；`1` 可完整恢复旧行为。
- 保留 `minIntervalMs`（默认 400 ms）作为**派发速率**上限，与并发窗口正交——
  窗口为 4、间隔 400 ms 时，第 4 个请求仍要等约 1.2 s 才发出。
- `pump` 单飞锁：`await delay()` 会让出执行权，没有该标志时第二个 pump 会抢走已计数的槽位、破坏 FIFO。
- 非法窗口（0/负数/小数/NaN）回落到默认值，避免死锁。
- 新增 `snapshotAll()` 供诊断：`{window, interval, lanes, totals, saturated}`。

**② 上游连接池**（新增 `src/upstream-client.js`）

- 旧行为：每请求走全局 `fetch`，新建 TCP+TLS。
- 新行为：`node:https` keep-alive `Agent`（`maxSockets 16`，`keepAliveMsecs 30 s`）。
- **不用 undici 的原因**：插件目录能 `import 'undici'` 只是因为 DSH 的 `node_modules` 在旁
  （未声明的隐性依赖），且其 dispatcher 协议与内置 `fetch` 不兼容——实测报
  `UND_ERR_INVALID_ARG: invalid onRequestStart method`。`node:https` 零依赖且是 keep-alive 的正主。
- `requestWithPool()` 返回 fetch 同形对象（`ok`/`status`/`headers.get`/`body`/`text()`），
  上层的 failover、quota、流式透传逻辑未改。

**③ 超时分层**（`src/shim.js`）

- 旧行为：单一 285 s，上游卡住要等近 5 分钟。
- 新行为：**首包 30 s**（响应头）+ **总 285 s**（头+体）。
- 首包超时**可 failover**：30 s 不确认说明上游有问题，换号/换模型重试是正确行为。
- 总超时能截断**已经开始的流**（`attemptDeadline` 挂 abort 到 stream），不会装作完整回答。
- 两个数都低于曾经互撞的两个 300 s 天花板（undici `headersTimeout`、DSH stream idle watchdog），
  失败时给出本插件自己的 504，而非 SDK 的「去配 dispatcher」。
- `headersDeadlineMs` 旧参数仍有效，作为首包层，不影响既有配置。

**④ 429/5xx 模型降权**（新增 `src/model-health.js`）

- 旧行为：`rate`/`server` 只换账号；单账号时等于用同一条死路重试 3 次。
- 新行为：同一模型连续失败 2 次即降权，冷却窗口指数退避 60s→120s→240s…上限 15 min。
- **连续计数而非时间窗**：时间窗会让偶发使用的好模型在恢复后仍被记恨；
  连续计数在首次成功即清零——那才是真正获得新信息的时刻。
- 只有 `rate`(429/810002) 和 `server`(5xx) 计数；`request`(客户端 bug) 与
  `credential`(账号问题) 不计，避免误伤健康模型。
- 选择器标签区分：`· 额度已用完`（810000，6h TTL）vs `· 暂时不可用`（降权中）。
- 顺带修掉一处**未接线的钩子**：`shim.js` 一直调用 `options.initialModel` 但 `index.js`
  从未实现，首次尝试因此不会跳过已知不可用的模型。现补齐，并抽出统一 `chainFor()`
  让首次尝试、fallback 跳转、诊断视图共用同一套可用性判断。

### 诊断

`/plugins/dsh-connect-autoclaw/provider` 新增两个字段：

```json
{
  "build": "2026-11-23-perf4-pool-window-timeout-health",
  "limiter": { "window": 4, "interval": 400, "lanes": {...}, "totals": {...}, "saturated": false },
  "modelHealth": { "demoted": [], "records": {} }
}
```

`limiter.saturated === true` 即窗口打满、有请求在排队——这是调 `maxConcurrentPerAccount` 前的判断依据。

### 实测（`zai_auto`，流式，真实网关，同一脚本口径）

| 并发 | 改造前 p50 | 改造后 p50 | 变化 | 吞吐 |
|---|---|---|---|---|
| 4 | 4331 ms | **1293 ms** | **−70%** | 0.36 → 0.54/s |
| 8 | 13625 ms | **2722 ms** | **−80%** | 0.27 → **1.25/s** |

成功率 36/36，超时 0%，错误 0%。

**单发 A/B（各 20 次，同代码 `--legacy` 对照）**：legacy p50 986 ms / 优化后 937 ms（−5%），
`min` 812 → 646 ms（−20%，省 TLS 握手）。历史上记录的 623 ms 是一次幸运样本——
上游波动 ±60%（实测散布 623–1489 ms），跨时段比对无意义，故引入 `--legacy` 做同代码对照。

### 新增文件

- `src/upstream-client.js`、`src/model-health.js`
- `test/upstream-client.test.js`（8）、`test/model-health.test.js`（12）
- `benchmarks/`：`bench.mjs`、`bench-with-sampler.mjs`、`shim-harness.mjs`（支持 `--legacy`）+ 6 份原始采样

### 测试

110/110 通过（原 84 + ratelimit 12（重写）+ 连接池 8 + 健康 6 净增）。
`ratelimit` 从 6 → 15 条、`shim` 15 → 16 条，均按新语义重写。

### 版本

`package.json` 2.5.1 → **2.6.0**；`index.js` build 标识 →
`2026-11-23-perf4-pool-window-timeout-health`。

## 2.5.1 (2026-11-22)

修复「上游流中途失败被吞成裸断连」。对齐 [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) issue #85 的同源教训：200 头已发出后再失败，直接 `res.destroy()` 会让 OpenAI 兼容客户端读到一次可重试的传输故障（`TypeError: terminated`），真实原因全部丢失；限流/凭据类失败还会让调用方拿同一个账号原样重打。

### 改动点

- **src/shim.js — 新增 `writeStreamError()`**：200 头已提交后上游流失败时，向仍开着的 body 写一条 SSE 错误帧
  `data: {"error":{"message":"<上游原因>","type":"upstream_error","code":"stream_failed"}}` 再结束。
  openai SDK 收到该帧会抛 `APIError`（message = 上游原始原因），内核据此分类，而不是降级成 TRANSPORT。
- **刻意不追加 `[DONE]`**：该哨兵断言「回答已完成」，是本路径唯一确知为假的事；只看哨兵的客户端不会把截断的轮次当完整。
- **中途失败写进 `onAccountOutcome`（network 类）并打 warn 日志**：「上游断流」在号池与日志里都留痕。
- **保留不动**：客户端主动断开（`controller.signal.aborted`）路径的 `destroy()`——无人接收，写帧无意义。
- **test/shim.test.js — 新增回归测试**：假网关发半个 SSE 后毁掉 socket，断言客户端拿到 200 + error 帧、type/code 正确、且没有 `[DONE]`。改回旧实现时该用例失败（13/14），恢复后通过（14/14）。
- **package.json**：版本 2.5.0 → 2.5.1。**index.js**：provider 诊断的 build 标识 → `2026-11-22-stream-error-frame`（线上可用 `/plugins/dsh-connect-autoclaw/provider` 读到，确认新代码已加载）。

实测对比（真实 openai SDK 读同一断流场景的产物）：旧路径 `TypeError: terminated`，无任何原因；新路径 `APIError`，message 为上游原始原因。

### 验证步骤

1. **仓库级**：`git clone` 后 `node --test`，应 79 pass 0 fail（无需登录、无需联网；新回归测试在内）。
2. **旧实现反证**：把 `src/shim.js` 的 `stream.on('error')` 回调临时改回
   `stream.on('error', () => { if (!res.destroyed) res.destroy(); resolve() })`，
   `node test/shim.test.js` 应 **fail 1**（mid-answer 用例）；恢复后 pass 14。证明测试真的能抓住旧 bug。
3. **SDK 级**：让一个 200 + SSE 的服务只发半帧后毁 socket，用真实 openai SDK 消费——
   新帧抛 `APIError`（message 保留），裸断连抛 `TypeError: terminated`。
4. **本机安装级（升级后）**：`GET /plugins/dsh-connect-autoclaw/provider` 的 `build` 应为
   `2026-11-22-stream-error-frame` 且 `registered:true`；`/status` `/catalog` `/accounts` 均 200；
   `POST /probe` 返回 `outcome:"ok"`（真实上游端到端）。
5. **已知未覆盖**：真实上游在流中途断开的在线复现（无法稳定构造），由单元测试覆盖。

### 回滚方法

1. **本机已装插件回滚（最快）**：升级前完整备份在
   `~/.dsh/vendor/dsh-connect-autoclaw.bak-2.5.0-<时间戳>.tgz`。
   恢复：解压覆盖 `~/.dsh/profiles/desktop/node_modules/dsh-connect-autoclaw`，
   然后重载插件（见下方「插件重载」）。`/provider` 的 build 回到
   `2026-11-22-quota-fallback` 即回滚成功。
2. **手动单点撤销**：`src/shim.js` 删除 `writeStreamError` 函数，`stream.on('error')` 回调改回
   `stream.on('error', () => { if (!res.destroyed) res.destroy(); resolve() })`；
   `test/shim.test.js` 删除 `brokenGateway` 及其用例。
3. **GitHub**：仓库文件历史（shim.js 的 commits 列表）里是逐版原文，可直接复制覆盖。

### 插件重载（本机 profile 热重载，无需重启 App）

本机 `plugin_manager` 工具不可用时，手工复刻 set_bundle 的同一动作（同一文件、同一效果）：

1. 编辑 `~/.dsh/profiles/desktop/package.json`，把 `"dsh-connect-autoclaw"` 从
   `dsh.profile.bundles` 数组移除，原子保存（临时文件 + rename）→ dsh-hmr 秒级热重载，插件下线；
2. 数秒后把该条加回原下标，再存 → 插件以新代码重新上线；
3. 全程用 `GET /plugins/dsh-connect-autoclaw/provider` 的 build 字段确认加载的是哪个版本。
