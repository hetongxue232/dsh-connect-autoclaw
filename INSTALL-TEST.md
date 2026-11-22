# 给测试者的安装与验收说明

包：`dsh-connect-autoclaw 2.5.0`（AutoClaw 积分接入 DeepSeek Harness，零配置）

## 前提（缺一不可）

1. **本机装了 AutoClaw 桌面版 2.x 并已登录**（插件只读它的登录态，不填任何 Key）
   - macOS：`~/Library/Application Support/AutoClaw-official/`
   - Windows：`%APPDATA%\AutoClaw-official\`
   - Linux：`$XDG_CONFIG_HOME/AutoClaw-official/` 或 `~/.config/AutoClaw-official/`
   - 装在别处：设 `AUTOCLAW_USER_DATA_ROOT` 指向用户数据根目录
2. **DSH 版本**：`@deepseek-ai/dsh-llm` 在 `>=0.1.7-rc.1 <0.3.0-0`（本机实测 `0.2.2-rc.2`）、`@earendil-works/pi-ai >=1.3.0`、`@deepseek-ai/cordis >=4.0.1`。版本不符时插件的 provider 半边不会加载（积分读数仍可用）。
3. Windows 需要 PowerShell（解 DPAPI 主密钥）；Linux 无 keyring 时用 Chromium 的 `peanuts` 兜底，必要时设 `AUTOCLAW_KEYRING_PASSWORD`。

## 安装（两种，任选一种）

**A. 本地目录**（推荐给测试，改代码即时生效）
1. 解压 zip，得到 `dsh-connect-autoclaw-2.5.0/` 文件夹
2. DSH → 插件 → 添加插件 → 本地目录 → 选这个文件夹
   （或用 `plugin_manager action=install_bundle target=<该文件夹绝对路径>`）

**B. tgz**
1. 把 `dsh-connect-autoclaw-2.5.0.tgz` 放到任意位置
2. 同上，安装目标填 `file:<tgz 绝对路径>`

装完在插件列表里确认 `include:dsh-connect-autoclaw` = enabled / active。

## 验收清单（装完逐条打勾）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 模型选择器 | 出现 `atuoclaw` 分组，5 个模型：`zai_auto` / `zai_auto-fast` / `zaicoding_glm-5.3` / `zai_glm-5.3-flash` / `zai_glm-5.3-flashx-legal` |
| 2 | 输入框旁 | 出现 `AutoClaw · <余额>` 读数，点开是账号/积分浮层 |
| 3 | 设置 → AutoClaw 页 | 四分区（账号 / 模型 / 能力 / 诊断），账号表显示手机号打码与余额 |
| 4 | 选 atuoclaw 模型发一句话 | 正常流式回答，不报 406 / 401 |
| 5 | 模型页「测试」按钮 | 三档（小 1万 / 标准 2.8万 / 大 5万 token），小档返回 `✓ … 约 0.9 积分` 与真实 prompt_tokens |
| 6 | 账号页 | 账号池开关默认关；可导入/导出账号 JSON、兑换码 |

**无浏览器时的等价验收**（把 `<PORT>` 换成 DSH Web GUI 实际端口）：

```bash
curl -s http://127.0.0.1:<PORT>/plugins/dsh-connect-autoclaw/status
# → {"ok":true,"total":<积分>,...}
curl -s http://127.0.0.1:<PORT>/plugins/dsh-connect-autoclaw/provider
# → registered:true, listModelsCount:5, catalogLive:true, error:""
curl -s http://127.0.0.1:<PORT>/plugins/dsh-connect-autoclaw/accounts
# → ok:true, rows[0].available:true
curl -s -X POST http://127.0.0.1:<PORT>/plugins/dsh-connect-autoclaw/probe \
  -H 'content-type: application/json' -d '{"model":"zai_glm-5.3-flash","tier":"small"}'
# → ok:true, outcome:"ok", promptTokens≈10046, pointsEstimate≈0.9
```

## 自测（可选，包里带了 40 个测试）

```bash
cd dsh-connect-autoclaw-2.5.0
node --test test/*.test.js
# → 40 pass, 0 fail（含 macOS/Windows/Linux 三平台密文 round-trip）
```

## 已知边界 / 请重点反馈

- **Windows 未经真机验证**（开发机是 macOS）。DPAPI 的 GCM 解密有单测，但 `Local State` 目录名 / DPAPI scope 若不同，请回报实际路径，用 `AUTOCLAW_USER_DATA_ROOT` 可先兜底。
- `zaicoding_glm-5.3` 走会员额度，免费额度用完返回 403「已用完」——这是额度不是故障。
- 探针/兑换码会真实消耗积分（小档 ~0.9，标准 ~2.6，大 ~4.6）。
- 上游若改了系统提示词白名单措辞，会重新出现空 body 406；改 `src/shim.js` 的 `REQUIRED_BANNER`。
- 长会话会更早触发压缩（v2.3.2 把目录预算钳到 131072/16384 以省积分），可能影响长上下文任务质量。

## 反馈时请附

1. 操作系统 + AutoClaw 版本 + DSH 版本
2. 上面验收清单里失败的那条 + 完整报错原文
3. `provider` 路由的完整 JSON（诊断信息，不含密钥）
