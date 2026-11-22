// The MCP server's protocol surface: handshake, tool list, and the two paths
// that must not hit the network (unknown method, unknown tool). The three real
// tools are exercised live in docs/MCP.md, not here — a unit test must not need
// a logged-in AutoClaw install.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))

/** Send frames, collect the replies, and stop the child. */
function exchange(frames) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = []
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') out.push(JSON.parse(line))
    })
    child.on('error', reject)
    child.on('close', () => resolve(out))
    for (const frame of frames) child.stdin.write(JSON.stringify(frame) + '\n')
    setTimeout(() => child.stdin.end(), 300)
  })
}

test('initialize echoes the protocol version and advertises tools', async () => {
  const [reply] = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  ])
  assert.equal(reply.id, 1)
  assert.equal(reply.result.protocolVersion, '2024-11-05')
  assert.deepEqual(reply.result.capabilities, { tools: {} })
  assert.equal(reply.result.serverInfo.name, 'autoclaw-points')
})

test('tools/list names all three read-only tools', async () => {
  const [reply] = await exchange([{ jsonrpc: '2.0', id: 2, method: 'tools/list' }])
  assert.deepEqual(
    reply.result.tools.map((tool) => tool.name),
    ['autoclaw_points', 'autoclaw_expiring', 'autoclaw_ledger'],
  )
  for (const tool of reply.result.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.description.length > 0, true)
  }
})

test('a notification gets no reply', async () => {
  const replies = await exchange([{ jsonrpc: '2.0', method: 'notifications/initialized' }])
  assert.deepEqual(replies, [])
})

test('an unknown method is a JSON-RPC error, not silence', async () => {
  const [reply] = await exchange([{ jsonrpc: '2.0', id: 3, method: 'nope/nothing' }])
  assert.equal(reply.error.code, -32601)
  assert.match(reply.error.message, /nope\/nothing/)
})

test('an unknown tool is a tool-level error the model can read', async () => {
  const [reply] = await exchange([
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } },
  ])
  assert.equal(reply.result.isError, true)
  assert.match(reply.result.content[0].text, /not_a_tool/)
})
