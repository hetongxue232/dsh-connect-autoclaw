# Changelog

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
