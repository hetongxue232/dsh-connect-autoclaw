# 把 AutoClaw 积分接进 AutoClaw

AutoClaw 的「工具 → 添加工具」只认 **MCP server**，装不了 DSH 插件。所以这里有个转接头：同一个凭据读取、同三条只读接口，包成 MCP 工具给 AutoClaw 自己的 agent 用。

```
AutoClaw agent
   └─ MCP (stdio) ──▶ mcp/server.mjs
                        ├─ 读 account-credentials.enc（safeStorage，只读）
                        └─ GET /agent-assetmgr/api/…  → 积分
```

## 填什么

在 **工具 → 添加工具** 里：

| 字段 | 值 |
|---|---|
| 名称 | `autoclaw-points` |
| 类型 | **本地程序** |
| 启动命令 | `<本机 node 的绝对路径>`（Windows：`node.exe`） |
| 参数 | `<本包解压目录>/mcp/server.mjs` |
| 环境变量 | 留空 |

启动命令要写**绝对路径**。AutoClaw 从自己的进程启动子进程，PATH 里未必有 `node`；用 `which node`（macOS/Linux）或 `where node`（Windows）查到真实路径，Windows 下指向 `node.exe`。

参数是脚本路径，同样要绝对路径。

## 三个工具

| 工具 | 回答 |
|---|---|
| `autoclaw_points` | 总余额 + 五个分钱包（奖励/每日/订阅/加油包/其他） |
| `autoclaw_expiring` | 多少积分快到期、多久（可传 `windowDays`，默认 7） |
| `autoclaw_ledger` | 最近流水（可传 `limit`，1–50，默认 20） |

全是只读，都不消耗积分。

## 实测输出

`autoclaw_points`：

```json
{ "total": 3767,
  "wallets": [
    { "type": "reward", "name": "奖励积分", "balance": 3767, "priority": 10, "displayed": true },
    { "type": "daily", "name": "每日积分", "balance": 0, "priority": 20, "displayed": false },
    { "type": "subscription", "name": "订阅积分", "balance": 0, "priority": 30, "displayed": false },
    { "type": "fuel_pack", "name": "加油包积分", "balance": 0, "priority": 40, "displayed": false },
    { "type": "other", "name": "其他积分", "balance": 0, "priority": 50, "displayed": false }
  ] }
```

`autoclaw_expiring`：

```json
{ "points": 3509, "total": 3509, "amount": 3, "unit": "day", "text": "3,509积分将于3天内到期" }
```

`autoclaw_ledger`：

```json
{ "entries": [
    { "id": "2398293", "amount": -50, "kind": "debit", "description": "AutoClaw GLM-5.3模型消耗积分" },
    { "id": "2398292", "amount": -6,  "kind": "debit", "description": "agent-dr open usage" }
  ] }
```

## 协议

MCP over stdio，换行分隔的 JSON-RPC 2.0。stdout 只走帧，诊断一律走 stderr（否则解析器会崩）。

实现了 `initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`。未知方法回 `-32601`，未知工具回一个 `isError: true` 的文本块——后者是为了让模型看得懂，而不是让它重试。

手工验一下：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"autoclaw_points","arguments":{}}}' \
| <node 绝对路径> <本包目录>/mcp/server.mjs
```

## 与 DSH 插件的关系

两个半身共用 `src/credential.js` 与 `src/upstream.js`，区别只在出口：

| 出口 | 谁用 | 形态 |
|---|---|---|
| `/plugins/dsh-connect-autoclaw/status`、`/ledgers` | DSH 页面 | HTTP 回环路由 |
| `mcp/server.mjs` | AutoClaw agent | MCP stdio |

改上游逻辑只需要改 `src/`，两边一起生效。

## 已知限制

- **首次调用会弹钥匙串授权。** `security` 要访问 `AutoClaw Safe Storage` 条目；同意后系统缓存。AutoClaw 自己启动子进程时可能弹在它自己的窗口后面。
- **每次调用重新读一次凭据与被解一次密。** 没有缓存：MCP 子进程是长驻的，但凭据文件随时可能被 app 重写（换号、刷新），缓存反而会读到旧令牌。
- **没有写操作。** 没有签到、没有兑换、没有领取——这些都要写接口，本桥一个都没有。
