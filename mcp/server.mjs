#!/usr/bin/env node
/**
 * AutoClaw 积分 → MCP stdio server.
 *
 * AutoClaw's agent can only call tools it discovers from an MCP server, so this
 * is the bridge: the same credential read and the same three read-only endpoints
 * the DSH plugin uses, exposed as MCP tools instead of an HTTP route.
 *
 * Wire protocol: newline-delimited JSON-RPC 2.0 on stdio, per the MCP spec.
 * stdout carries frames only — any diagnostic goes to stderr.
 *
 * Add it in AutoClaw under 工具 → 添加工具:
 *   名称       autoclaw-points
 *   类型       本地程序
 *   启动命令   <本机 node 可执行文件的绝对路径，Windows 用 node.exe>
 *   参数       <本包解压目录>/mcp/server.mjs
 *
 * @module dsh-connect-autoclaw/mcp/server
 */

import { createInterface } from 'node:readline'
import { readCredential } from '../src/credential.js'
import {
  appVersion,
  createUpstream,
  expiringOf,
  ledgersOf,
  readDeviceId,
  refreshAccessToken,
  walletsOf,
} from '../src/upstream.js'

const SERVER_INFO = { name: 'autoclaw-points', version: '1.0.0' }
const DEFAULT_PROTOCOL = '2024-11-05'

/** The three tools, described so the model knows what each answers. */
const TOOLS = [
  {
    name: 'autoclaw_points',
    description:
      'Read the AutoClaw points wallet: total balance plus the five sub-wallets (奖励/每日/订阅/加油包/其他). Read-only, costs nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'autoclaw_expiring',
    description:
      'Read how many AutoClaw points expire soon and when, using the gateway\'s own wording (e.g. "5,000积分将于3天内到期"). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        windowDays: { type: 'number', description: 'How far ahead to look, in days. Default 7.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'autoclaw_ledger',
    description: 'Read recent AutoClaw point ledger entries (what was granted or spent, and when). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many entries, 1–50. Default 20.' },
      },
      additionalProperties: false,
    },
  },
]

/** Build an upstream client for the app's current session, refreshing once if refused. */
async function connect() {
  const credential = await readCredential({})
  const version = await appVersion({})
  let token = credential.accessToken
  let refreshed = false
  return createUpstream({
    baseURL: 'https://autoglm-api.zhipuai.cn',
    version,
    token,
    onUnauthorized: async () => {
      if (refreshed) return undefined
      refreshed = true
      const deviceId = await readDeviceId()
      const next = await refreshAccessToken({
        baseURL: 'https://autoglm-api.zhipuai.cn',
        refreshToken: credential.refreshToken,
        deviceId,
        version,
      })
      if (next !== undefined) token = next
      return next
    },
  })
}

/** Every tool this server answers; anything else is rejected before any I/O. */
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name))

/** Tool name → its answer, as one text block. */
async function callTool(name, args) {
  // Answer an unknown name first: `connect()` reads the credential store, and on
  // a host without AutoClaw it throws — which would report a credential problem
  // for what is really a caller typo.
  if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool "${name}"`)
  const upstream = await connect()

  if (name === 'autoclaw_points') {
    const result = await upstream.wallets()
    if (!result.ok) throw new Error(`${result.message} (code ${result.code})`)
    return JSON.stringify(
      {
        total: typeof result.data?.total_balance === 'number' ? result.data.total_balance : 0,
        wallets: walletsOf(result.data),
      },
      null,
      2,
    )
  }

  if (name === 'autoclaw_expiring') {
    const days = Number(args?.windowDays ?? 7)
    const seconds = Math.min(Math.max(Number.isFinite(days) ? days : 7, 1), 366) * 86400
    const result = await upstream.expiring(seconds)
    if (!result.ok) throw new Error(`${result.message} (code ${result.code})`)
    const view = expiringOf(result.data)
    return JSON.stringify(view === undefined ? { expiring: 0, text: '这段时间内没有到期积分' } : view, null, 2)
  }

  if (name === 'autoclaw_ledger') {
    const limit = Math.min(Math.max(Number(args?.limit ?? 20), 1), 50)
    const result = await upstream.ledgers(limit)
    if (!result.ok) throw new Error(`${result.message} (code ${result.code})`)
    return JSON.stringify({ entries: ledgersOf(result.data) }, null, 2)
  }

  throw new Error(`unknown tool "${name}"`)
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

/** Handle one frame. Notifications have no id and get no response. */
async function handle(frame) {
  const { id, method, params } = frame
  const isNotification = id === undefined || id === null

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })

  if (method === 'tools/call') {
    const name = params?.name
    try {
      const text = await callTool(name, params?.arguments)
      return reply(id, { content: [{ type: 'text', text }] })
    } catch (error) {
      return reply(id, {
        content: [{ type: 'text', text: `读取失败：${String(error?.message ?? error)}` }],
        isError: true,
      })
    }
  }

  if (isNotification) return
  replyError(id, -32601, `method not found: ${String(method)}`)
}

const lines = createInterface({ input: process.stdin, terminal: false })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    process.stderr.write(`autoclaw-points: dropped a non-JSON line\n`)
    return
  }
  handle(frame).catch((error) => {
    process.stderr.write(`autoclaw-points: ${String(error?.message ?? error)}\n`)
  })
})
lines.on('close', () => process.exit(0))
