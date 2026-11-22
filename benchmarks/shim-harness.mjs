/**
 * 压测用的独立 shim + 诊断路由（同一进程、同一个 limiter）。
 *
 * 运行中的 DSH 把 shim secret 藏在进程内，外部取不到，所以从外部压测运行中的
 * 实例既发不出请求、也读不到它的 limiter 状态。这个 harness 把 shim 与
 * `/provider` 诊断路由放进**同一个进程**，共用同一个 limiter——这样"边压测边
 * 采样"看到的 active/queued 就是压测请求真正排队的那条队列。
 *
 * 代码路径与生产一致：同一个 createShim、同一个 createAccountLimiter。
 *
 * 用法:
 *   node shim-harness.mjs [--interval 400] [--window 4] [--port 0]
 * 输出: {"chat":"http://...","token":"...","diag":"http://...","window":4,"interval":400}
 */
import { createServer } from 'node:http'
import { createShim } from '../src/shim.js'
import { readCredential } from '../src/credential.js'
import { createAccountLimiter } from '../src/ratelimit.js'
import {
  noteQuotaExhausted,
  fallbackChain,
} from '../src/quota.js'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const WINDOW = Number(arg('window', '4'))
const INTERVAL = Number(arg('interval', '400'))
const PORT = Number(arg('port', '0'))

const quota = {}
const CATALOG = ['zai_auto', 'zai_auto-fast', 'zaicoding_glm-5.3', 'zai_glm-5.3-flash', 'zai_glm-5.3-flashx-legal']
const chainFor = (m) => fallbackChain({ model: m, catalog: CATALOG, preferred: 'zai_auto', quota })

const LEGACY = argv.includes('--legacy')
const limiter = createAccountLimiter({
  // Legacy mode: strictly serial (window 1), to A/B the optimisations against
  // the pre-change behaviour on the SAME code, not against an old measurement.
  maxConcurrentPerAccount: LEGACY ? 1 : WINDOW,
  minIntervalMs: INTERVAL,
})

const shim = createShim({
  limiter,
  // Legacy: a fresh connection per request, like the pre-pool code did.
  ...(LEGACY ? { poolOptions: { keepAlive: false } } : {}),
  baseURL: 'https://autoglm-api.zhipuai.cn',
  getAccount: async () => await readCredential({ accountRoot: '' }),
  onQuotaExhausted: (m, d) => noteQuotaExhausted(quota, m, d),
  initialModel: (m) => chainFor(m)[0],
  nextFallback: (f) => chainFor(f).find((i) => i !== f),
})
await shim.ready

// 诊断端口：只暴露 limiter，与本进程的 shim 共享同一个队列。
const diag = createServer((req, res) => {
  if (req.url?.startsWith('/provider')) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ limiter: limiter.snapshotAll() }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => diag.listen(PORT, '127.0.0.1', resolve))
const diagPort = diag.address().port

console.log(JSON.stringify({
  chat: shim.baseUrl(),
  token: shim.token(),
  diag: `http://127.0.0.1:${diagPort}`,
  window: limiter.snapshotAll().window,
  interval: limiter.snapshotAll().interval,
}))

const shutdown = async () => {
  diag.closeAllConnections?.(); diag.close()
  await shim.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
