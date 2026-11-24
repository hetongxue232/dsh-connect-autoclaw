/**
 * Browser half of the AutoClaw (atuoclaw) integration for DSH.
 *
 * The interface is a deliberate one-to-one reconstruction of the shared
 * "connector" card that two sibling plugins maintain together:
 *
 *   - dsh-connect-trae        MIT, Copyright (c) 2026 LaoDing
 *   - dsh-connect-workbuddy   MIT (参考 corrinehu/dsh-workbuddy-connect)
 *
 * Both keep a file called `series-layout.ts` whose first line says the two
 * bridge plugins maintain it in sync. What is reproduced here is THAT shared
 * skeleton, not either plugin's features:
 *
 *   - the same slot set (settings.section + its icon, two composer seats,
 *     model.label, main, sidebar.panellist), with the same ids and orders;
 *   - three surfaces (page / settings section / legacy card) drawing ONE
 *     `cardBody` tree, so the shape cannot drift between them;
 *   - two tab layers: a boxed "scope" row and a sticky underlined section row;
 *   - the grid table, the three padded stat cards, the diagnostic rows,
 *     the `dsm-btn` primitive, and the 12px silent composer trigger with its
 *     portalled popover;
 *   - the exact `series-layout` metrics (1120px page, 8px/12px tab cells,
 *     7px/11px section tabs, 10px/14px table rows, 13px/32px buttons) and the
 *     full `--dsw-alias-*` token fallbacks.
 *
 * What is NOT reproduced is anything that belongs to those plugins' data
 * rather than their shape: Trae's account pool, daily check-in, enterprise /
 * international regions, model checkboxes, thinking tiers, image generation
 * and promo badges; WorkBuddy's CLI bridge, code-11128 rescue, context
 * rescue, OAuth and device SDK. AutoClaw has one account and one provider, so
 * the scope row carries ONE chip (not a fake three-way choice) and the
 * "capabilities" section reports provider facts read-only instead of drawing
 * switches that could not be saved.
 *
 * Every credit figure on this page comes from the plugin's own Host routes
 * (`/plugins/dsh-connect-autoclaw/*`). Nothing here writes upstream.
 */
window.__ModuleLoader__.load({
  id: 'dsh-connect-autoclaw',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // react-dom is externalized by the host's client loader (the sibling
    // plugins do exactly this). A host that does not serve it falls back to an
    // in-place popover instead of dropping the readout entirely.
    let ReactDOM
    try { ReactDOM = require('react-dom') } catch { ReactDOM = undefined }

    const STATUS = '/plugins/dsh-connect-autoclaw/status'
    const LEDGERS = '/plugins/dsh-connect-autoclaw/ledgers'
    const PROVIDER = '/plugins/dsh-connect-autoclaw/provider'
    const CATALOG = '/plugins/dsh-connect-autoclaw/catalog'
    const ACCOUNTS_SELECT = '/plugins/dsh-connect-autoclaw/accounts/select'
    const ACCOUNTS_IMPORT = '/plugins/dsh-connect-autoclaw/accounts/import'
    const ACCOUNTS_EXPORT = '/plugins/dsh-connect-autoclaw/accounts/export'
    const POOL = '/plugins/dsh-connect-autoclaw/pool'
    const REDEEM = '/plugins/dsh-connect-autoclaw/accounts/redeem'
    const PROBE = '/plugins/dsh-connect-autoclaw/probe'
    const REFRESH_MS = 5 * 60 * 1000
    const NS = 'settings.atuoclaw'
    const PANEL_ID = 'dsh-connect-autoclaw'

    /** The one provider route this plugin owns. */
    const OWN_PROVIDERS = new Set(['atuoclaw'])
    /** Prefixes of the model ids the AutoClaw gateway advertises. */
    const OWN_MODEL_RE = /^(zai_|zaicoding_)/

    /** Avoid the contested priority 0 that every other contributor defaults to. */
    const MODEL_LABEL_PRIORITY = -102

    const zh = {
      'nav.label': 'AutoClaw',
      'nav.panel': 'AutoClaw',
      'nav.back': '返回会话',
      'row.title': 'AutoClaw 积分',
      'row.desc': '复用本机 AutoClaw 桌面版已登录的积分额度，装好即用，无需填写 API Key 或模型参数。',
      'row.tabAria': '供应商',
      'row.tabAccount': 'AutoClaw',
      'row.tabHint': '这一页只读：所有数字都来自 AutoClaw 自己的积分接口。',
      'row.tabCredentialHint': '凭据取自本机 AutoClaw 的登录态，插件只读不写。',
      'row.tabFreeQuotaWarn': '部分模型走会员额度，免费额度用完后网关会返回「已用完」。',
      'row.tabStateOn': '已连接',
      'row.tabStateOff': '未连接',
      'row.panelAria': '分区',
      'row.panelAccounts': '账号',
      'row.panelModels': '模型',
      'row.panelCapabilities': '能力',
      'row.panelDiag': '诊断',
      'row.refresh': '刷新',
      'row.refreshing': '读取中…',
      'row.fetchedAt': '读取于 {time}',
      'overview.title': '剩余积分',
      'overview.unit': '积分',
      'overview.wallets': '分钱包',
      'overview.walletsHint': '括号内为有余额的钱包数',
      'overview.noExpiry': '近 7 天无到期积分',
      'overview.expiring': '到期提醒',
      'overview.refresh': '刷新',
      'overview.reading': '读取中…',
      'overview.fetchedAt': '读取于 {time}',
      'table.wallet': '钱包',
      'table.balance': '余额',
      'table.ledger': '记录',
      'table.amount': '变化',
      'wallets.note': '余额为 0 的钱包来自上游，只是当前没有分配额度。',
      'ledgers.empty': '暂无流水',
      'err.credential': '未读到 AutoClaw 凭据：{reason}',
      'err.upstream': '网关拒绝：{reason}',
      'err.network': '读取失败：{reason}',
      'diag.account': '账号',
      'diag.updatedAt': '凭据更新时间',
      'diag.refreshed': '本次已刷新令牌',
      'diag.baseURL': '网关',
      'diag.hint': '这一页只读。所有数字来自 AutoClaw 自己的积分接口，插件不写入、不改动账号状态。',
      'diag.yes': '是',
      'diag.no': '否',
      'diag.provider': 'Provider 路由',
      'diag.shim': '回环 shim',
      'diag.registered': '已注册',
      'diag.catalogError': '目录错误',
      'diag.none': '—',
      'model.title': '账号可用的模型',
      'model.name': '名称',
      'model.id': 'ID',
      'model.credit': '倍率',
      'model.context': '上下文',
      'model.output': '最大输出',
      'model.reasoning': '思考档',
      'model.vision': '图片',
      'model.visionYes': '支持',
      'model.empty': '模型目录还没读到，点「刷新」。',
      'model.note': '模型清单来自 AutoClaw 网关，倍率与思考档以上游发布为准。',
      'model.refresh': '刷新目录',
      'model.refreshing': '刷新中…',
      'model.updated': '目录更新于 {time}',
      'model.refreshFail': '目录刷新失败：{message}',
      'model.quotaSpent': '额度已用完',
      'model.quotaHint': '标为「额度已用完」的模型，网关会拒绝对它的请求；发出这类请求时会自动回退到 Auto 继续回答。',
      'model.speed': '输出速度',
      'model.measureSpeed': '测速',
      'model.measuring': '测速中…',
      'model.speedHint': '每个模型跑 3 次取中位数：同一模型单次可能相差数倍，一次测量会把运气当真相。测速按实际生成的 token 数除以生成耗时，不含首字等待。',
      'model.speedFailed': '无法测速',
      'model.speedEstimated': '≈',
      'cap.title': '接入能力',
      'cap.note': '以下是插件自身的运行状态，只读。',
      'cap.provider': 'Provider 路由',
      'cap.gateway': '上游网关',
      'cap.shim': '回环 shim',
      'cap.registered': 'provider 已注册',
      'cap.banner': '系统提示词门禁',
      'cap.bannerOn': '已启用（请求会被改写）',
      'cap.models': '已发现模型',
      'cap.yes': '是',
      'cap.no': '否',
      'composer.label': 'AutoClaw',
      'composer.reading': '读取中…',
      'composer.panelTitle': 'AutoClaw 积分',
      'composer.open': '打开 AutoClaw 面板',
      'composer.refresh': '刷新',
      'composer.refreshing': '刷新中…',
      'composer.expiring': '{text}',
      'composer.noExpiry': '近 7 天无到期',
      'composer.account': '账号',
      'composer.balance': '积分',
      'composer.lastRefresh': '更新于 {time}',
      'composer.signedOut': '未读到 AutoClaw 登录态',
      'composer.openPanel': '打开面板',
      'pool.title': '账号池',
      'pool.switchLabel': '自动换号',
      'pool.switchHint': '开启后按「先到期 → 余额多」自动挑号；失败自动换下一个',
      'pool.hint': '账号池默认关闭：换账号等于换人计费，只能由你点头。关闭时严格使用当前选中的账号。',
      'pool.empty': '没有读到任何账号。装 AutoClaw 并登录，或在下面导入。',
      'pool.colAccount': '账号',
      'pool.colBalance': '积分',
      'pool.sourceApp': '本机',
      'pool.sourceImported': '导入',
      'pool.current': '当前',
      'pool.use': '用这个',
      'pool.noCheckin': 'AutoClaw 没有签到接口（每日积分是自动发放的）；下面是它真实提供的兑换码。',
      'pool.codePlaceholder': '兑换码',
      'pool.redeem': '兑换',
      'pool.redeemOk': '兑换成功，余额稍后自动刷新',
      'pool.redeemFail': '兑换失败',
      'pool.codeEmpty': '兑换码是空的',
      'pool.export': '导出账号',
      'pool.import': '导入账号',
      'pool.importDone': '导入完成：新增 {added}，更新 {updated}，跳过 {skipped}',
      'pool.importFail': '导入失败',
      'probe.title': '连通性测试',
      'probe.hint': '上游按请求体积限流：小请求「测出可用」不代表长对话能用。测试发的是真实体积请求，结果同时喂给账号池。',
      'probe.tierAria': '测试体积',
      'probe.tierSmall': '小（1万 token）',
      'probe.tierSmallHint': '快速验证连通性，约 0.9 积分',
      'probe.tierStandard': '标准（2.8万 token）',
      'probe.tierStandardHint': '覆盖默认会话体积，约 2.6 积分',
      'probe.tierLarge': '大（5万 token）',
      'probe.tierLargeHint': '长对话用户选这个，约 4.6 积分',
      'probe.test': '测试',
      'probe.running': '测试中…',
      'probe.okLine': '✓ {model} · 实测 {tokens} input token · {latency}s · 约 {points} 积分',
      'probe.failLine': '✗ {model} · {outcome}：{message}',
    }

    const en = {
      'nav.label': 'AutoClaw',
      'nav.panel': 'AutoClaw',
      'nav.back': 'Back to conversation',
      'row.title': 'AutoClaw points',
      'row.desc': 'Reuses the points on this machine\'s logged-in AutoClaw desktop app. Install and use, with no API key or model parameters to enter.',
      'row.tabAria': 'Provider',
      'row.tabAccount': 'AutoClaw',
      'row.tabHint': 'Read-only: every figure comes from AutoClaw\'s own points API.',
      'row.tabCredentialHint': 'The credential is read from the local AutoClaw sign-in; nothing is written.',
      'row.tabFreeQuotaWarn': 'Some models use the membership quota; the gateway reports "used up" once the free allowance is gone.',
      'row.tabStateOn': 'connected',
      'row.tabStateOff': 'not connected',
      'row.panelAria': 'Sections',
      'row.panelAccounts': 'Accounts',
      'row.panelModels': 'Models',
      'row.panelCapabilities': 'Capabilities',
      'row.panelDiag': 'Diagnostics',
      'row.refresh': 'Refresh',
      'row.refreshing': 'reading…',
      'row.fetchedAt': 'read at {time}',
      'overview.title': 'Points left',
      'overview.unit': 'points',
      'overview.wallets': 'Wallets',
      'overview.walletsHint': 'badge counts the funded ones',
      'overview.noExpiry': 'nothing expires in the next 7 days',
      'overview.expiring': 'Expiring',
      'overview.refresh': 'Refresh',
      'overview.reading': 'reading…',
      'overview.fetchedAt': 'read at {time}',
      'table.wallet': 'Wallet',
      'table.balance': 'Balance',
      'table.ledger': 'Entry',
      'table.amount': 'Change',
      'wallets.note': 'Zero-balance wallets come from the gateway; they simply hold no allowance right now.',
      'ledgers.empty': 'No entries',
      'err.credential': 'AutoClaw credential unreadable: {reason}',
      'err.upstream': 'Gateway refused: {reason}',
      'err.network': 'Read failed: {reason}',
      'diag.account': 'Account',
      'diag.updatedAt': 'Credential updated',
      'diag.refreshed': 'Token refreshed this read',
      'diag.baseURL': 'Gateway',
      'diag.hint': 'This page is read-only. Every figure comes from AutoClaw\'s own points API; nothing is written and no account state is changed.',
      'diag.yes': 'yes',
      'diag.no': 'no',
      'diag.provider': 'Provider route',
      'diag.shim': 'Loopback shim',
      'diag.registered': 'Registered',
      'diag.catalogError': 'Catalog error',
      'diag.none': '—',
      'model.title': 'Models available to this account',
      'model.name': 'Name',
      'model.id': 'ID',
      'model.credit': 'Rate',
      'model.context': 'Context',
      'model.output': 'Max output',
      'model.reasoning': 'Thinking',
      'model.vision': 'Image',
      'model.visionYes': 'yes',
      'model.empty': 'The model catalog has not been read yet. Press Refresh.',
      'model.note': 'The catalog comes from the AutoClaw gateway; rates and thinking tiers are as published upstream.',
      'model.refresh': 'Refresh catalog',
      'model.refreshing': 'refreshing…',
      'model.updated': 'catalog updated {time}',
      'model.refreshFail': 'Catalog refresh failed: {message}',
      'model.quotaSpent': 'quota spent',
      'model.quotaHint': 'Models marked "quota spent" are refused by the gateway; a request that lands on one falls back to Auto automatically.',
      'model.speed': 'Output',
      'model.measureSpeed': 'Measure',
      'model.measuring': 'measuring…',
      'model.speedHint': 'Three runs per model, median. One model can vary several-fold between runs, so a single sample reports luck as truth. Rate = generated tokens / generation span, excluding time to first token.',
      'model.speedFailed': 'not measured',
      'model.speedEstimated': '≈',
      'cap.title': 'Integration capabilities',
      'cap.note': 'The plugin\'s own runtime facts, read-only.',
      'cap.provider': 'Provider route',
      'cap.gateway': 'Upstream gateway',
      'cap.shim': 'Loopback shim',
      'cap.registered': 'Provider registered',
      'cap.banner': 'System-prompt gate',
      'cap.bannerOn': 'on (requests are rewritten)',
      'cap.models': 'Models discovered',
      'cap.yes': 'yes',
      'cap.no': 'no',
      'composer.label': 'AutoClaw',
      'composer.reading': 'reading…',
      'composer.panelTitle': 'AutoClaw points',
      'composer.open': 'Open the AutoClaw panel',
      'composer.refresh': 'Refresh',
      'composer.refreshing': 'refreshing…',
      'composer.expiring': '{text}',
      'composer.noExpiry': 'nothing expires in 7 days',
      'composer.account': 'Account',
      'composer.balance': 'Points',
      'composer.lastRefresh': 'updated {time}',
      'composer.signedOut': 'No AutoClaw sign-in found',
      'composer.openPanel': 'Open panel',
      'pool.title': 'Account pool',
      'pool.switchLabel': 'Auto switch',
      'pool.switchHint': 'When on, requests pick by soonest-expiring then largest balance; failures move to the next account',
      'pool.hint': 'The pool defaults to OFF: switching accounts switches who pays, so only you may turn it on. When off, the selected account serves strictly.',
      'pool.empty': 'No account found. Install AutoClaw and sign in, or import one below.',
      'pool.colAccount': 'Account',
      'pool.colBalance': 'Points',
      'pool.sourceApp': 'local',
      'pool.sourceImported': 'imported',
      'pool.current': 'current',
      'pool.use': 'Use',
      'pool.noCheckin': 'AutoClaw has no check-in endpoint (the daily grants are automatic); below is the redeem-code route it does publish.',
      'pool.codePlaceholder': 'Redeem code',
      'pool.redeem': 'Redeem',
      'pool.redeemOk': 'Redeemed; the balance refreshes shortly',
      'pool.redeemFail': 'Redeem failed',
      'pool.codeEmpty': 'The code is empty',
      'pool.export': 'Export',
      'pool.import': 'Import',
      'pool.importDone': 'Imported: {added} added, {updated} updated, {skipped} skipped',
      'pool.importFail': 'Import failed',
      'probe.title': 'Connectivity probe',
      'probe.hint': 'Upstream throttles by REQUEST SIZE: a ping answering "usable" does not mean a long conversation will pass. The probe sends a real-volume request and feeds the result to the account pool.',
      'probe.tierAria': 'Probe size',
      'probe.tierSmall': 'Small (10k tokens)',
      'probe.tierSmallHint': 'Quick liveness check, ~0.9 points',
      'probe.tierStandard': 'Standard (28k tokens)',
      'probe.tierStandardHint': 'Covers the default conversation size, ~2.6 points',
      'probe.tierLarge': 'Large (50k tokens)',
      'probe.tierLargeHint': 'For routinely-long conversations, ~4.6 points',
      'probe.test': 'Test',
      'probe.running': 'testing…',
      'probe.okLine': '✓ {model} · {tokens} input tokens measured · {latency}s · ~{points} points',
      'probe.failLine': '✗ {model} · {outcome}: {message}',
    }

    // ---------------------------------------------------------------- helpers

    /** Floor before grouping, so a balance never rounds up. */
    function credits(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return Math.floor(value).toLocaleString('en-US')
    }
    function signed(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const text = credits(Math.abs(value))
      return value > 0 ? `+${text}` : value < 0 ? `-${text}` : '0'
    }
    function shortId(id) {
      return typeof id === 'string' && id.length > 8 ? `${id.slice(0, 6)}…` : String(id ?? '')
    }
    function stamp(iso) {
      if (typeof iso !== 'string') return undefined
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    function clock(iso) {
      if (typeof iso !== 'string') return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      return response.json()
    }

    /** The 16px brand glyph. `currentColor` so the host paints selection state. */
    function PanelIcon(props) {
      const edge = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', { width: edge, height: edge, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
        className: 'dsm-autoclaw-nav-icon', style: { borderRadius: '4px', display: 'block', opacity: props?.active === false ? 0.75 : 1 } },
        h('rect', { x: 1, y: 1, width: 14, height: 14, rx: 4, fill: 'var(--dsw-alias-brand-primary,#5686fe)' }),
        h('path', { d: 'M4.4 8.2c1.4-2 2.6-2 3.6 0s2.2 2 3.6 0', stroke: '#fff', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }
    /** The 40px page icon: the same mark, filled for the page head. */
    function PageIcon() {
      return h('svg', { className: 'dsm-autoclaw-page-icon', width: 40, height: 40, viewBox: '0 0 40 40', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 1, y: 1, width: 38, height: 38, rx: 9, fill: 'var(--dsw-alias-brand-primary,#5686fe)' }),
        h('path', { d: 'M9 21c4-6 7-6 11 0s7 6 11 0', stroke: '#fff', strokeWidth: 2.4, strokeLinecap: 'round' }),
      )
    }
    function DiagRow(props) {
      return h('div', { className: 'dsm-autoclaw-diag-row' },
        h('span', { className: 'dsm-autoclaw-diag-label' }, props.label),
        h('span', { className: `dsm-autoclaw-diag-value${props.mono ? ' dsm-autoclaw-diag-mono' : ''}${props.bad ? ' dsm-autoclaw-diag-bad' : ''}` }, props.value),
      )
    }
    /** Two columns, aligned between the header row and every data row. */
    function Table(props) {
      return h('div', { className: 'dsm-autoclaw-table' },
        h('div', { className: 'dsm-autoclaw-row dsm-autoclaw-row-head', role: 'row' },
          h('span', { role: 'columnheader' }, props.left),
          h('span', { className: 'dsm-autoclaw-col-value', role: 'columnheader' }, props.right),
        ),
        ...props.rows,
      )
    }
    function TableRow(props) {
      return h('div', { className: 'dsm-autoclaw-row', role: 'row' },
        h('span', { className: 'dsm-autoclaw-cell', role: 'cell' },
          h('span', { className: 'dsm-autoclaw-name' }, props.name),
          props.meta === undefined ? null : h('span', { className: 'dsm-autoclaw-meta' }, props.meta),
          props.tag === undefined ? null : h('span', { className: 'dsm-autoclaw-current-tag' }, props.tag),
        ),
        h('span', { className: `dsm-autoclaw-value ${props.tone ?? 'dsm-autoclaw-value-credit'}`, role: 'cell' }, props.value),
      )
    }

    // ------------------------------------------------------- composer popover

    /**
     * Anchor a fixed-position panel above its trigger, then keep it there on
     * scroll and resize. Ported in shape from the siblings' `useAnchoredPosition`
     * (~40 lines of DOM geometry they keep local rather than import).
     */
    function useAnchoredPosition(open, anchorRef, panelRef) {
      const [position, setPosition] = React.useState(undefined)
      React.useLayoutEffect(() => {
        if (open !== true || typeof document === 'undefined') { setPosition(undefined); return undefined }
        const measure = () => {
          const anchor = anchorRef.current
          if (anchor === null || anchor === undefined) return
          const rect = anchor.getBoundingClientRect()
          const panel = panelRef.current
          const width = panel?.offsetWidth || 264
          const height = panel?.offsetHeight || 180
          const margin = 12
          let left = rect.right - width
          left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
          let top = rect.top - height - 8
          if (top < margin) top = rect.bottom + 8
          setPosition({ left, top })
        }
        measure()
        const raf = requestAnimationFrame(measure)
        window.addEventListener('resize', measure)
        document.addEventListener('scroll', measure, true)
        return () => {
          cancelAnimationFrame(raf)
          window.removeEventListener('resize', measure)
          document.removeEventListener('scroll', measure, true)
        }
      }, [open, anchorRef, panelRef])
      return position
    }

    /**
     * The points readout itself. Registered in TWO seats, drawn in one.
     *
     * The sibling plugins portal this panel to document.body because the docked
     * composer clips its children; the same reason applies here. A host without
     * react-dom gets the same markup rendered in place (degraded, not absent).
     */
    function ComposerPoints(props) {
      const { t, position, onOpenPanel } = props
      const [status, setStatus] = React.useState(undefined)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const rootRef = React.useRef(null)
      const anchorRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const anchored = useAnchoredPosition(open, anchorRef, panelRef)

      const load = React.useCallback((fresh) => getJson(fresh === true ? `${STATUS}?fresh=1` : STATUS)
        .then((next) => setStatus(next))
        .catch((error) => setStatus({ ok: false, reason: 'NETWORK', message: String(error?.message ?? error) })), [])

      React.useEffect(() => {
        load(false)
        const timer = setInterval(() => load(false), REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])
      React.useEffect(() => { if (open) load(true) }, [open, load])

      // Outside press / Escape. The panel lives outside the trigger's root once
      // portalled, so BOTH containers are checked before dismissing.
      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          const target = event.target
          if (rootRef.current?.contains(target)) return
          if (panelRef.current?.contains(target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const refresh = () => { setBusy(true); load(true).finally(() => setBusy(false)) }
      const ok = status?.ok === true
      const failed = status?.ok === false
      const value = ok ? credits(status.total) : status === undefined ? t('composer.reading') : '—'

      const panel = h('div', {
        ref: panelRef,
        className: 'dsm-autoclaw-composer-panel',
        style: anchored ?? { visibility: 'hidden', left: 0, top: 0 },
        role: 'dialog',
        'aria-label': t('composer.panelTitle'),
      },
        h('div', { className: 'dsm-autoclaw-composer-panel-head' },
          h('span', { className: 'dsm-autoclaw-composer-panel-title' }, t('composer.panelTitle')),
          h('span', { className: 'dsm-autoclaw-composer-panel-actions' },
            h('button', { type: 'button', className: 'dsm-autoclaw-composer-panel-refresh', disabled: busy, onClick: refresh },
              h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', 'aria-hidden': true, className: busy ? 'dsm-autoclaw-spin' : '' },
                h('path', { d: 'M13.3 8a5.3 5.3 0 1 1-1.55-3.75', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
                h('path', { d: 'M13.4 2.2v2.9h-2.9', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
              ),
              h('span', null, busy ? t('composer.refreshing') : t('composer.refresh')),
            ),
          ),
        ),
        failed === true ? h('p', { className: 'dsm-autoclaw-composer-panel-error', role: 'alert' }, status.message ?? status.reason) : null,
        ok === true
          ? h('div', null,
              h('table', { className: 'dsm-autoclaw-composer-panel-table' },
                h('thead', null, h('tr', null,
                  h('th', { scope: 'col' }, t('composer.account')),
                  h('th', { scope: 'col', className: 'dsm-autoclaw-composer-panel-num' }, t('composer.balance')),
                )),
                h('tbody', null, h('tr', { className: 'dsm-autoclaw-composer-panel-row-current' },
                  h('th', { scope: 'row' },
                    h('span', { className: 'dsm-autoclaw-composer-panel-dot', 'aria-hidden': true }),
                    h('span', { className: 'dsm-autoclaw-composer-panel-who' },
                      h('span', { className: 'dsm-autoclaw-composer-panel-name' }, status.account?.profile?.phone ?? shortId(status.account?.id)),
                      h('span', { className: 'dsm-autoclaw-composer-panel-mark' }, t('row.tabStateOn')),
                    ),
                  ),
                  h('td', { className: 'dsm-autoclaw-composer-panel-num' }, credits(status.total)),
                )),
              ),
              h('p', { className: 'dsm-autoclaw-composer-panel-note' },
                status.expiring?.text ?? t('composer.noExpiry')),
            )
          : !failed ? h('p', { className: 'dsm-autoclaw-composer-panel-empty' }, t('composer.reading')) : null,
        h('div', { className: 'dsm-autoclaw-composer-panel-foot' },
          h('span', null, t('composer.lastRefresh', { time: clock(status?.fetchedAt) })),
          typeof onOpenPanel === 'function'
            ? h('button', { type: 'button', className: 'dsm-autoclaw-composer-panel-settings', onClick: onOpenPanel }, t('composer.openPanel'))
            : null,
        ),
      )

      const canPortal = typeof ReactDOM?.createPortal === 'function' && typeof document !== 'undefined' && document.body != null

      return h('span', { className: 'dsm-autoclaw-composer-points', ref: rootRef },
        h('button', {
          ref: anchorRef,
          type: 'button',
          className: 'dsm-autoclaw-composer-points-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: t('composer.open'),
          onClick: () => setOpen(!open),
        }, `${t('composer.label')} · ${value}`),
        open === true ? (canPortal ? ReactDOM.createPortal(panel, document.body) : panel) : null,
      )
    }

    /**
     * The ownership + seat gate.
     *
     * Both siblings register the readout in `conversation.input.right` (order 4)
     * and `conversation.composer.dock` (order 10), then render in only ONE of
     * them. The ownership test reads the Host's `modelSelection` projection so
     * this readout never competes with WorkBuddy's for the shared row; `next`
     * wins over `lastUsed` because a selection already made is what the composer
     * shows the user.
     *
     * A host that does not supply `useProjection` is treated as "unknown" and
     * still gets the readout: silently drawing nothing forever is worse than
     * occasionally sharing the row.
     */
    function ComposerGate(props) {
      const { t, position, useProjection, onOpenPanel } = props
      let projection
      try { projection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined } catch { projection = undefined }
      const candidate = projection?.next ?? projection?.lastUsed
      const provider = typeof candidate?.provider === 'string' ? candidate.provider : undefined
      // EXACTLY the siblings' rule: an unnamed or foreign provider draws
      // nothing, so the shared row is never occupied by us. No "unknown"
      // fallback — that would be a third behaviour neither reference has.
      if (provider === undefined || !OWN_PROVIDERS.has(provider)) return null
      // One account and no creditPosition setting, so the composer row is the
      // only seat that draws; the dock registration stays as the sibling's
      // second seat, empty until a seat setting exists.
      if ((position ?? 'composer') !== 'composer') return null
      return h(ComposerPoints, { t, position: position ?? 'composer', onOpenPanel })
    }

    /**
     * The model-picker label. `conversation.input.model.label` is a `single`
     * slot on some hosts, so whoever holds it must draw EVERY provider's rows:
     * a foreign provider gets its plain name, ours gets a small brand dot.
     */
    function ModelLabel(props) {
      const model = props?.model
      const name = props?.name ?? props?.label ?? props?.children ?? model?.name ?? model?.id
      const id = typeof model === 'string' ? model : model?.id
      const provider = props?.provider
      const ours = (typeof provider === 'string' && OWN_PROVIDERS.has(provider)) || (typeof id === 'string' && OWN_MODEL_RE.test(id))
      if (!ours) return name === undefined || name === null ? null : h('span', null, name)
      return h('span', { className: 'dsm-autoclaw-model-label' },
        h('span', { className: 'dsm-autoclaw-model-label-dot', 'aria-hidden': true }),
        name === undefined || name === null ? '' : name,
      )
    }

    // ----------------------------------------------------------- usage card

    const ACCOUNTS = '/plugins/dsh-connect-autoclaw/accounts'


    /**
     * The connectivity probe UI (shape from `dsh-connect-workbuddy`'s per-model
     * 测试 button): a tier selector, one button per model, and the result —
     * status, real prompt tokens, latency, and an honest points estimate from
     * the ledger-measured price (55 积分 / 599,014 token). The probe runs in
     * the Host; credentials never reach the page.
     */
    function ModelProbePanel(props) {
      const { t, catalog } = props
      const [tier, setTier] = React.useState('standard')
      const [busyModel, setBusyModel] = React.useState(undefined)
      const [result, setResult] = React.useState(undefined)
      const [note, setNote] = React.useState(undefined)

      // The Host persists the last tier so a page reload keeps the user's
      // choice; the probe route itself is the authority on which tier ran.
      React.useEffect(() => {
        getJson(ACCOUNTS).then((r) => {
          if (r?.ok === true && ['small', 'standard', 'large'].includes(r.probeTier)) setTier(r.probeTier)
        }).catch(() => {})
      }, [])

      const tiers = [
        ['small', 'probe.tierSmall', 'probe.tierSmallHint'],
        ['standard', 'probe.tierStandard', 'probe.tierStandardHint'],
        ['large', 'probe.tierLarge', 'probe.tierLargeHint'],
      ]

      const test = (modelId) => {
        setBusyModel(modelId)
        setNote(undefined)
        fetch(PROBE, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: modelId, tier }),
        })
          .then((r) => r.json())
          .then((r) => setResult(r))
          .catch((error) => setResult({ ok: false, outcome: 'network', message: String(error?.message ?? error) }))
          .finally(() => setBusyModel(undefined))
      }

      const resultLine = result === undefined
        ? null
        : result.ok === true
          ? h('p', { className: 'dsm-autoclaw-probe-result dsm-autoclaw-probe-ok', role: 'status' },
              t('probe.okLine', {
                model: result.model,
                tokens: credits(result.promptTokens),
                latency: String((result.latencyMs / 1000).toFixed(1)),
                points: String(result.pointsEstimate ?? '?'),
              }))
          : h('p', { className: 'dsm-autoclaw-probe-result dsm-autoclaw-probe-bad', role: 'alert' },
              t('probe.failLine', { model: result.model ?? '?', outcome: result.outcome ?? 'failed', message: result.message ?? '' }))

      return h('div', { className: 'dsm-autoclaw-section' },
        h('div', { className: 'dsm-autoclaw-accounts-head' },
          h('span', { className: 'dsm-autoclaw-section-title' }, t('probe.title')),
        ),
        h('p', { className: 'dsm-autoclaw-panel-note' }, t('probe.hint')),
        h('div', { className: 'dsm-autoclaw-probe-tiers', role: 'radiogroup', 'aria-label': t('probe.tierAria') },
          ...tiers.map(([id, labelKey, hintKey]) =>
            h('label', { key: id, className: 'dsm-autoclaw-probe-tier', title: t(hintKey) },
              h('input', {
                type: 'radio', name: 'dsm-autoclaw-probe-tier', value: id,
                checked: tier === id,
                disabled: busyModel !== undefined,
                onChange: () => setTier(id),
              }),
              h('span', null, t(labelKey)),
            )),
        ),
        catalog.length === 0 ? h('p', { className: 'dsm-autoclaw-panel-note' }, t('model.empty')) : null,
        h('div', { className: 'dsm-autoclaw-account-row-actions' },
          ...catalog.map((row) =>
            h('button', {
              key: row.id, type: 'button', className: 'dsm-btn dsm-btn-outline',
              disabled: busyModel !== undefined,
              onClick: () => test(row.id),
            }, busyModel === row.id ? t('probe.running') : `${t('probe.test')} ${row.name ?? row.id}`)),
        ),
        resultLine,
        note === undefined ? null : h('p', { className: 'dsm-autoclaw-panel-note', role: 'status' }, note),
      )
    }


    /**
     * The account roster + pool controls, ported in shape from
     * `dsh-connect-workbuddy`'s account panel: one table (who serves, what is
     * left), a pool switch (explicit, default OFF — switching accounts means
     * switching who pays), and import/export.
     *
     * ONE HONEST ABSENCE: AutoClaw publishes no check-in endpoint — the daily
     * grants in the ledger are automatic. In its place this panel offers the
     * redeem-code route the upstream DOES publish
     * (`/agent-assetmgr/api/v1/autoglm-codes/redeem`), and says so.
     */
    function AccountsPanel(props) {
      const { t } = props
      const [roster, setRoster] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(undefined)
      const [code, setCode] = React.useState('')
      const fileRef = React.useRef(null)

      const load = React.useCallback((fresh) => getJson(fresh === true ? `${ACCOUNTS}?fresh=1` : ACCOUNTS)
        .then((next) => setRoster(next))
        .catch((error) => setRoster({ ok: false, message: String(error?.message ?? error) })), [])

      React.useEffect(() => { load(false) }, [load])

      const act = (promise) => {
        setBusy(true)
        promise.finally(() => { setBusy(false); load(true) })
      }
      const select = (accountId) => act(fetch(ACCOUNTS_SELECT, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId }),
      }).then((r) => r.json()).then((r) => setNote(r.ok === true ? undefined : r.message)))
      const setPool = (enabled) => act(fetch(POOL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      }).then((r) => r.json()).then((r) => setNote(r.ok === true ? undefined : r.message)))
      const redeem = () => {
        if (code.trim() === '') { setNote(t('pool.codeEmpty')); return }
        act(fetch(REDEEM, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: code.trim() }),
        }).then((r) => r.json()).then((r) => {
          setNote(r.ok === true ? t('pool.redeemOk') : `${t('pool.redeemFail')}${r.message ? `：${r.message}` : ''}`)
          if (r.ok === true) setCode('')
        }))
      }
      const onImportFile = (event) => {
        const file = event.currentTarget.files?.[0]
        if (file === undefined) return
        act(file.text().then((text) => fetch(ACCOUNTS_IMPORT, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: text,
        }).then((r) => r.json()).then((r) => {
          setNote(r.ok === true
            ? t('pool.importDone', { added: String(r.added ?? 0), updated: String(r.updated ?? 0), skipped: String(r.skipped ?? 0) })
            : `${t('pool.importFail')}${r.message ? `：${r.message}` : ''}`)
        })))
        event.currentTarget.value = ''
      }
      const doExport = () => {
        window.open(ACCOUNTS_EXPORT, '_blank')
      }

      const rows = Array.isArray(roster?.rows) ? roster.rows : []

      return h('div', { className: 'dsm-autoclaw-section' },
        h('div', { className: 'dsm-autoclaw-accounts-head' },
          h('span', { className: 'dsm-autoclaw-section-title' }, t('pool.title')),
          h('label', { className: 'dsm-autoclaw-switch', title: t('pool.switchHint') },
            h('input', {
              type: 'checkbox',
              checked: roster?.poolEnabled === true,
              disabled: busy === true || roster?.ok !== true,
              onChange: (event) => setPool(event.currentTarget.checked),
            }),
            h('span', { className: 'dsm-autoclaw-switch-label' }, t('pool.switchLabel')),
          ),
        ),
        h('p', { className: 'dsm-autoclaw-panel-note' }, t('pool.hint')),
        rows.length === 0 && roster !== undefined
          ? h('p', { className: 'dsm-autoclaw-panel-note' }, t('pool.empty'))
          : null,
        rows.length > 0
          ? h(Table, {
              left: t('pool.colAccount'), right: t('pool.colBalance'),
              rows: rows.map((row) => h(TableRow, {
                key: row.accountId,
                name: row.name ?? row.phone ?? shortId(row.accountId),
                meta: row.source === 'vault' ? t('pool.sourceImported') : t('pool.sourceApp'),
                tag: row.selected === true ? t('pool.current') : undefined,
                value: row.balance === undefined || row.available !== true ? '—' : credits(row.balance),
                tone: row.selected === true ? 'dsm-autoclaw-value-credit' : 'dsm-autoclaw-value-dim',
              })),
            })
          : null,
        rows.length > 1 || (rows.length === 1 && rows[0].selected !== true)
          ? h('div', { className: 'dsm-autoclaw-account-row-actions' },
              ...rows.filter((row) => row.selected !== true && row.available).map((row) =>
                h('button', {
                  key: row.accountId, type: 'button', className: 'dsm-btn dsm-btn-outline',
                  disabled: busy === true,
                  onClick: () => select(row.accountId),
                }, `${t('pool.use')} ${row.name ?? row.phone ?? shortId(row.accountId)}`)),
            )
          : null,
        h('p', { className: 'dsm-autoclaw-panel-note dsm-autoclaw-free-quota-warn' }, t('pool.noCheckin')),
        h('div', { className: 'dsm-autoclaw-account-actions' },
          h('input', {
            className: 'dsm-autoclaw-redeem-input',
            type: 'text', value: code, placeholder: t('pool.codePlaceholder'),
            disabled: busy === true,
            onChange: (event) => setCode(event.currentTarget.value),
          }),
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-outline', disabled: busy === true || code.trim() === '', onClick: redeem }, t('pool.redeem')),
        ),
        h('div', { className: 'dsm-autoclaw-account-actions' },
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-outline', disabled: busy === true, onClick: doExport }, t('pool.export')),
          h('button', { type: 'button', className: 'dsm-btn dsm-btn-outline', disabled: busy === true, onClick: () => fileRef.current?.click() }, t('pool.import')),
          h('input', { ref: fileRef, type: 'file', accept: 'application/json,.json', style: { display: 'none' }, onChange: onImportFile }),
        ),
        note === undefined ? null : h('p', { className: 'dsm-autoclaw-panel-note', role: 'status' }, note),
        roster?.ok === false ? h('p', { className: 'dsm-autoclaw-account-error', role: 'alert' }, roster.message ?? '') : null,
      )
    }

    /** One `cardBody` value, drawn by all three surfaces. */
    function UsageCard(props) {
      const { t, surface, backToConversation, onOpenPanel } = props
      const [status, setStatus] = React.useState(undefined)
      const [ledgers, setLedgers] = React.useState(undefined)
      const [provider, setProvider] = React.useState(undefined)
      const [panel, setPanel] = React.useState('accounts')
      const [busy, setBusy] = React.useState(false)
      const [catalogBusy, setCatalogBusy] = React.useState(false)
      const [tps, setTps] = React.useState(undefined)
      const [tpsBusy, setTpsBusy] = React.useState(false)
      const [catalogNote, setCatalogNote] = React.useState(undefined)
      // Legacy collapsible-card surface keeps its own open state. Declared at
      // the TOP LEVEL on purpose: a hook inside a conditional return branch
      // would change the hook order between renders.
      const [cardOpen, setCardOpen] = React.useState(true)

      const load = React.useCallback((fresh) => Promise.all([
        getJson(fresh === true ? `${STATUS}?fresh=1` : STATUS).catch((error) => ({ ok: false, reason: 'NETWORK', message: String(error?.message ?? error) })),
        getJson(LEDGERS).catch((error) => ({ ok: false, message: String(error?.message ?? error) })),
        getJson(PROVIDER).catch(() => undefined),
      ]).then(([nextStatus, nextLedgers, nextProvider]) => {
        setStatus(nextStatus); setLedgers(nextLedgers); setProvider(nextProvider)
      }), [])

      React.useEffect(() => {
        load(false)
        const timer = setInterval(() => load(false), REFRESH_MS)
        return () => clearInterval(timer)
      }, [load])
      const refresh = () => { setBusy(true); load(true).finally(() => setBusy(false)) }

      // Hot-refresh the model catalog: the host re-reads the gateway and
      // re-announces the route, then this page re-reads its provider state so
      // the table shows the fresh rows. No process restart involved.
      // Speed measurement is separate from the catalog read: it costs real
      // tokens, so it runs only when the button is pressed.
      const measureSpeed = () => {
        setTpsBusy(true)
        fetch('/plugins/dsh-connect-autoclaw/tps', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })
          .then((r) => r.json())
          .then((r) => { if (r?.ok === true) setTps(r.samples ?? []) })
          .catch(() => {})
          .finally(() => setTpsBusy(false))
      }

      const refreshCatalog = () => {
        setCatalogBusy(true)
        setCatalogNote(undefined)
        getJson(`${CATALOG}?refresh=1`)
          .then((r) => {
            if (r?.ok === true) load(false)
            else setCatalogNote(r?.message ?? String(r?.reason ?? 'unknown'))
          })
          .catch((error) => setCatalogNote(String(error?.message ?? error)))
          .finally(() => setCatalogBusy(false))
      }

      const failed = status?.ok === false
      const errorText = failed === true
        ? t(status.reason === 'CREDENTIAL' ? 'err.credential' : status.reason === 'NETWORK' ? 'err.network' : 'err.upstream', { reason: status.message ?? status.reason })
        : undefined
      const signedIn = status?.ok === true
      const catalog = Array.isArray(provider?.catalog) ? provider.catalog : []

      const sections = [
        ['accounts', 'row.panelAccounts'],
        ['models', 'row.panelModels'],
        ['capabilities', 'row.panelCapabilities'],
        ['diag', 'row.panelDiag'],
      ]

      const cardBody = h('div', { className: 'dsm-autoclaw-usage' },
        // SCOPE ROW — the boxed chip layer. One chip because there is one
        // provider. A checkbox here would imply a provider toggle AutoClaw does
        // not implement (the sibling's switch writes a real setting), so the
        // same cell carries a read-only connection state instead.
        h('div', { className: 'dsm-autoclaw-tabs', role: 'tablist', 'aria-label': t('row.tabAria') },
          h('div', { className: 'dsm-autoclaw-tab-cell', role: 'presentation' },
            h('button', { type: 'button', role: 'tab', 'aria-selected': true, className: 'dsm-autoclaw-tab dsm-autoclaw-tab-active' },
              h('span', { className: `dsm-autoclaw-tab-dot${signedIn ? ' dsm-autoclaw-tab-dot-ok' : ''}`, 'aria-hidden': true }),
              t('row.tabAccount'),
            ),
            h('span', { className: 'dsm-autoclaw-tab-state' }, t(signedIn ? 'row.tabStateOn' : 'row.tabStateOff')),
          ),
        ),
        h('div', { className: 'dsm-autoclaw-region-summary' },
          h('p', { className: 'dsm-autoclaw-models-summary' }, t('row.tabHint')),
          h('p', { className: 'dsm-autoclaw-models-summary' }, t('row.tabCredentialHint')),
          h('p', { className: 'dsm-autoclaw-models-summary dsm-autoclaw-free-quota-warn' }, t('row.tabFreeQuotaWarn')),
        ),
        errorText === undefined ? null : h('p', { className: 'dsm-autoclaw-usage-error', role: 'alert' }, errorText),

        // SECTION ROW — the sticky underlined layer.
        h('div', { className: 'dsm-autoclaw-panels', role: 'tablist', 'aria-label': t('row.panelAria') },
          ...sections.map(([id, key]) => h('button', {
            key: id, type: 'button', role: 'tab',
            id: `dsm-autoclaw-tab-${id}`,
            'aria-controls': `dsm-autoclaw-panel-${id}`,
            'aria-selected': panel === id,
            className: `dsm-autoclaw-panel-tab${panel === id ? ' dsm-autoclaw-panel-tab-active' : ''}`,
            onClick: () => setPanel(id),
          }, t(key))),
        ),

        // ACCOUNTS — the three stat cards, refresh, and the wallet/ledger tables.
        h('div', { className: 'dsm-autoclaw-panel', role: 'tabpanel', id: 'dsm-autoclaw-panel-accounts', 'aria-labelledby': 'dsm-autoclaw-tab-accounts', hidden: panel !== 'accounts' },
          status === undefined ? h('p', { className: 'dsm-autoclaw-panel-note' }, t('overview.reading')) : null,
          h(AccountsPanel, { t }),
          signedIn ? h('div', { className: 'dsm-autoclaw-stats' },
            h('div', { className: 'dsm-autoclaw-stat' },
              h('span', { className: 'dsm-autoclaw-stat-head' }, t('overview.title')),
              h('span', { className: 'dsm-autoclaw-stat-value' }, credits(status.total)),
              h('span', { className: 'dsm-autoclaw-stat-hint' }, t('overview.unit')),
            ),
            h('div', { className: 'dsm-autoclaw-stat' },
              h('span', { className: 'dsm-autoclaw-stat-head' }, t('overview.expiring')),
              h('span', { className: `dsm-autoclaw-stat-value${status.expiring === undefined ? '' : ' dsm-autoclaw-stat-value-warn'}` }, status.expiring === undefined ? '0' : credits(status.expiring.points)),
              h('span', { className: 'dsm-autoclaw-stat-hint' }, status.expiring?.text ?? t('overview.noExpiry')),
            ),
            h('div', { className: 'dsm-autoclaw-stat' },
              h('span', { className: 'dsm-autoclaw-stat-head' },
                t('overview.wallets'),
                h('span', { className: 'dsm-autoclaw-stat-badge' }, String((status.wallets ?? []).filter((w) => w.balance > 0).length)),
              ),
              h('span', { className: 'dsm-autoclaw-stat-value' }, String((status.wallets ?? []).length)),
              h('span', { className: 'dsm-autoclaw-stat-hint' }, t('overview.walletsHint')),
            ),
          ) : null,
          signedIn ? h('div', { className: 'dsm-autoclaw-account-actions' },
            h('button', { type: 'button', className: 'dsm-btn dsm-btn-outline', disabled: busy, onClick: refresh }, busy ? t('row.refreshing') : t('row.refresh')),
            status.fetchedAt === undefined ? null : h('span', { className: 'dsm-autoclaw-panel-note' }, t('row.fetchedAt', { time: stamp(status.fetchedAt) })),
          ) : null,
          h('div', { className: 'dsm-autoclaw-section' },
            h(Table, {
              left: t('table.wallet'), right: t('table.balance'),
              rows: (status?.wallets ?? []).map((wallet) => h(TableRow, {
                key: wallet.type, name: wallet.name, meta: wallet.type, value: credits(wallet.balance),
                tone: wallet.balance > 0 ? 'dsm-autoclaw-value-credit' : 'dsm-autoclaw-value-dim',
              })),
            }),
            h('p', { className: 'dsm-autoclaw-panel-note' }, t('wallets.note')),
          ),
          h('div', { className: 'dsm-autoclaw-section' },
            ledgers?.ok === true && (ledgers.entries ?? []).length === 0 ? h('p', { className: 'dsm-autoclaw-panel-note' }, t('ledgers.empty')) : null,
            ledgers?.ok === true && (ledgers.entries ?? []).length > 0
              ? h(Table, {
                  left: t('table.ledger'), right: t('table.amount'),
                  rows: ledgers.entries.map((entry) => h(TableRow, {
                    key: entry.id, name: entry.description || entry.kind, meta: entry.at, value: signed(entry.amount),
                    tone: entry.amount < 0 ? 'dsm-autoclaw-value-warn' : 'dsm-autoclaw-value-credit',
                  })),
                })
              : null,
          ),
        ),

        // MODELS — the catalog the gateway advertised, kept whole, plus the
        // connectivity probe. The probe posts a REAL-VOLUME request (three
        // tiers), because upstream throttles on request size: a ping answers
        // “usable” for an account that refuses the very next long message.
        h('div', { className: 'dsm-autoclaw-panel', role: 'tabpanel', id: 'dsm-autoclaw-panel-models', 'aria-labelledby': 'dsm-autoclaw-tab-models', hidden: panel !== 'models' },
          h(ModelProbePanel, { t, catalog }),
          h('div', { className: 'dsm-autoclaw-accounts-head' },
            h('span', { className: 'dsm-autoclaw-section-title' }, t('model.title')),
            h('button', {
              type: 'button', className: 'dsm-btn dsm-btn-outline',
              disabled: catalogBusy === true,
              onClick: refreshCatalog,
            }, catalogBusy === true ? t('model.refreshing') : t('model.refresh')),
          ),
          provider?.catalogUpdatedAt ? h('p', { className: 'dsm-autoclaw-panel-note' }, t('model.updated', { time: stamp(provider.catalogUpdatedAt) })) : null,
          catalogNote !== undefined ? h('p', { className: 'dsm-autoclaw-panel-note dsm-autoclaw-free-quota-warn', role: 'alert' }, t('model.refreshFail', { message: catalogNote })) : null,
          h('div', { className: 'dsm-autoclaw-accounts-head' },
            h('span', { className: 'dsm-autoclaw-section-title' }, t('model.speed')),
            h('button', {
              type: 'button', className: 'dsm-btn dsm-btn-outline',
              disabled: tpsBusy === true,
              onClick: measureSpeed,
            }, tpsBusy === true ? t('model.measuring') : t('model.measureSpeed')),
          ),
          h('p', { className: 'dsm-autoclaw-panel-note' }, t('model.speedHint')),
          catalog.some((row) => row.quotaExhausted === true)
            ? h('p', { className: 'dsm-autoclaw-panel-note dsm-autoclaw-free-quota-warn' }, t('model.quotaHint'))
            : null,
          catalog.length === 0 ? h('p', { className: 'dsm-autoclaw-panel-note' }, t('model.empty')) : null,
          catalog.length > 0 ? h('div', { className: 'dsm-autoclaw-model-table' },
            h('div', { className: 'dsm-autoclaw-model-row dsm-autoclaw-model-row-head', role: 'row' },
              ...[t('model.name'), t('model.credit'), t('model.speed'), t('model.context'), t('model.output'), t('model.reasoning'), t('model.vision')].map((label) => h('span', { role: 'columnheader' }, label)),
            ),
            ...catalog.map((row) => h('div', {
              className: `dsm-autoclaw-model-row${row.quotaExhausted === true ? ' dsm-autoclaw-model-row-spent' : ''}`,
              role: 'row', key: row.id, 'aria-disabled': row.quotaExhausted === true ? 'true' : undefined,
            },
              h('span', { className: 'dsm-autoclaw-model-name', role: 'cell' },
                h('span', { className: 'dsm-autoclaw-name' }, row.name ?? row.id),
                h('span', { className: 'dsm-autoclaw-meta' }, row.id),
                row.quotaExhausted === true ? h('span', { className: 'dsm-autoclaw-quota-flag' }, t('model.quotaSpent')) : null,
              ),
              h('span', { role: 'cell' }, Number.isFinite(row.creditCostFactor) ? `x${row.creditCostFactor}` : (row.credit || '—')),
              h('span', { role: 'cell', className: 'dsm-autoclaw-model-num' }, (() => {
                const sample = Array.isArray(tps) ? tps.find((s) => s.modelId === row.id) : undefined
                if (sample === undefined) return '—'
                if (!Number.isFinite(sample.tokensPerSecond)) return t('model.speedFailed')
                return `${sample.estimated === true ? t('model.speedEstimated') : ''}${Math.round(sample.tokensPerSecond)} tok/s`
              })()),
              h('span', { role: 'cell', className: 'dsm-autoclaw-model-num' }, row.contextWindow ? credits(row.contextWindow) : '—'),
              h('span', { role: 'cell', className: 'dsm-autoclaw-model-num' }, row.maxTokens ? credits(row.maxTokens) : '—'),
              h('span', { role: 'cell' }, Array.isArray(row.reasoningLevels) ? row.reasoningLevels.join('/') : '—'),
              h('span', { role: 'cell' }, row.multimodal ? t('model.visionYes') : '—'),
            )),
          ) : null,
          h('p', { className: 'dsm-autoclaw-panel-note' }, t('model.note')),
        ),

        // CAPABILITIES — provider facts, read-only, from the diag route.
        h('div', { className: 'dsm-autoclaw-panel', role: 'tabpanel', id: 'dsm-autoclaw-panel-capabilities', 'aria-labelledby': 'dsm-autoclaw-tab-capabilities', hidden: panel !== 'capabilities' },
          h('p', { className: 'dsm-autoclaw-section-title' }, t('cap.title')),
          h('p', { className: 'dsm-autoclaw-panel-note' }, t('cap.note')),
          h('div', { className: 'dsm-autoclaw-diag' },
            h(DiagRow, { label: t('cap.provider'), value: provider?.provider ?? 'atuoclaw', mono: true }),
            h(DiagRow, { label: t('cap.gateway'), value: status?.baseURL ?? '—', mono: true }),
            h(DiagRow, { label: t('cap.shim'), value: provider?.shimUrl || '—', mono: true }),
            h(DiagRow, { label: t('cap.registered'), value: provider?.registered === true ? t('cap.yes') : t('cap.no'), bad: provider?.registered !== true }),
            h(DiagRow, { label: t('cap.banner'), value: t('cap.bannerOn') }),
            h(DiagRow, { label: t('cap.models'), value: String(provider?.catalogSize ?? catalog.length) }),
          ),
        ),

        // DIAGNOSTICS — credential and gateway facts for a bug report.
        h('div', { className: 'dsm-autoclaw-panel', role: 'tabpanel', id: 'dsm-autoclaw-panel-diag', 'aria-labelledby': 'dsm-autoclaw-tab-diag', hidden: panel !== 'diag' },
          h('div', { className: 'dsm-autoclaw-diag' },
            h(DiagRow, { label: t('diag.account'), value: shortId(status?.account?.id), mono: true }),
            h(DiagRow, { label: t('diag.updatedAt'), value: stamp(status?.account?.updatedAt) ?? t('diag.none') }),
            h(DiagRow, { label: t('diag.refreshed'), value: status?.account?.refreshed === true ? t('diag.yes') : t('diag.no'), bad: status?.account?.refreshed === true }),
            h(DiagRow, { label: t('diag.baseURL'), value: status?.baseURL ?? t('diag.none'), mono: true }),
            h(DiagRow, { label: t('diag.provider'), value: provider?.provider ?? 'atuoclaw', mono: true }),
            h(DiagRow, { label: t('diag.catalogError'), value: provider?.catalogError || t('diag.none'), bad: Boolean(provider?.catalogError) }),
          ),
          h('p', { className: 'dsm-autoclaw-diag-hint' }, t('diag.hint')),
        ),
      )

      // THREE SURFACES share the one tree; only the chrome around it differs.
      const pageHead = h('div', { className: 'dsm-autoclaw-page-head' },
        typeof backToConversation === 'function'
          ? h('button', { type: 'button', className: 'dsm-autoclaw-page-back', onClick: backToConversation },
              h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
                h('path', { d: 'M10 3.5 5.5 8l4.5 4.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })),
              h('span', null, t('nav.back')),
            )
          : null,
        h(PageIcon),
        h('span', { className: 'dsm-autoclaw-page-title' }, t('row.title')),
        h('span', { className: 'dsm-autoclaw-page-desc' }, t('row.desc')),
      )

      if (surface === 'page' || surface === undefined) {
        return h('div', { className: 'dsm-autoclaw-page' },
          pageHead,
          h('div', { className: 'dsm-autoclaw-page-body' }, cardBody),
        )
      }
      if (surface === 'section') {
        return h('div', { className: 'dsm-autoclaw-section-surface' },
          h('div', { className: 'dsm-autoclaw-section-head' },
            h('h2', { className: 'dsm-autoclaw-section-title' }, t('row.title')),
            h('p', { className: 'dsm-autoclaw-section-desc' }, t('row.desc')),
          ),
          cardBody,
        )
      }
      // Legacy collapsible card (a host that still serves the plugin-detail seat).
      const open = cardOpen
      return h('li', { className: `dsm-plugin-card${open ? ' dsm-plugin-card-open' : ''}` },
        h('button', { type: 'button', className: 'dsm-plugin-card-header', 'aria-expanded': open, onClick: () => setCardOpen(!open) },
          h(PanelIcon, { size: 20 }),
          h('span', { className: 'dsm-plugin-card-head' },
            h('span', { className: 'dsm-plugin-card-title' }, t('row.title')),
            h('span', { className: 'dsm-plugin-card-description' }, t('row.desc')),
          ),
          h('span', { 'aria-hidden': true, className: `dsm-plugin-card-chevron${open ? ' dsm-plugin-card-chevron-open' : ''}` }),
        ),
        h('div', { className: 'dsm-plugin-card-body', hidden: !open }, open ? cardBody : null),
      )
    }

    // ------------------------------------------------------------- styles

    /**
     * One stylesheet, injected once per document.
     *
     * Metrics are the two siblings' shared `series-layout` values, copied
     * rule-for-rule where they apply: 1120px page (WorkBuddy's override of
     * Trae's 860, kept after the owner rejected the narrower card), 8px/12px
     * tab cells on a 10px radius, 7px/11px sticky section tabs, 10px/14px
     * table rows, 13px/32px buttons, and a 12px borderless composer trigger
     * with a 264px portalled popover. All colours are `--dsw-alias-*` tokens
     * with the same fallbacks both plugins ship.
     */
    const CSS = String.raw`
/* PROBE UI: tier radio pills + per-model test buttons + one result line. */
.dsm-autoclaw-probe-tiers{display:flex;gap:8px;flex-wrap:wrap}
.dsm-autoclaw-probe-tier{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:999px;background:var(--dsw-alias-bg-layer-2,#24262c);cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-autoclaw-probe-tier:has(input:checked){border-color:var(--dsw-alias-brand-primary,#5686fe);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-autoclaw-probe-tier input{appearance:none;width:12px;height:12px;border-radius:50%;border:1px solid var(--dsw-alias-label-dimmed,#777);margin:0;cursor:pointer}
.dsm-autoclaw-probe-tier input:checked{background:var(--dsw-alias-brand-primary,#5686fe);border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:inset 0 0 0 2px var(--dsw-alias-bg-layer-3,#2a2c33)}
.dsm-autoclaw-probe-tier input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-autoclaw-probe-tier input:disabled{cursor:default}
.dsm-autoclaw-probe-result{margin:8px 0 0;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.dsm-autoclaw-probe-ok{color:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-autoclaw-probe-bad{color:var(--dsw-alias-state-error-primary,#ef4444);overflow-wrap:anywhere}

/* ACCOUNT POOL (shape from dsh-connect-workbuddy's account panel): the same
   raw-accent switch the siblings use, one row per account in the grid table,
   and a narrow redeem input. */
.dsm-autoclaw-accounts-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-autoclaw-switch{display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-autoclaw-switch input{appearance:none;width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l2,#3a3d45);position:relative;cursor:pointer;transition:background .15s,border-color .15s;margin:0}
.dsm-autoclaw-switch input::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999);transition:transform .15s,background .15s}
.dsm-autoclaw-switch input:checked{background:var(--dsw-alias-brand-primary,#5686fe);border-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-autoclaw-switch input:checked::after{transform:translateX(14px);background:#fff}
.dsm-autoclaw-switch input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-autoclaw-switch input:disabled{opacity:.5;cursor:default}
.dsm-autoclaw-account-row-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsm-autoclaw-redeem-input{appearance:none;font:inherit;min-width:0;flex:1;max-width:280px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#24262c);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:20px}
.dsm-autoclaw-redeem-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}

.dsm-autoclaw-page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;gap:20px;padding:28px clamp(24px,4vw,48px) 48px;overflow:auto;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-autoclaw-page>*{width:100%;max-width:1120px}
.dsm-autoclaw-page-head{display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1,#17181b);border-radius:12px;padding:10px 12px}
.dsm-autoclaw-page-back{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-1,#17181b);color:var(--dsw-alias-label-secondary,#c7c7c7);border-radius:8px;padding:5px 12px;display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:13px;line-height:20px}
.dsm-autoclaw-page-back:hover{color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-autoclaw-page-back svg{flex:none}
.dsm-autoclaw-page-icon{width:40px;height:40px;border-radius:9px;align-self:flex-start;margin-top:14px}
.dsm-autoclaw-page-title{margin:0;font-size:20px;font-weight:600;line-height:1.4}
.dsm-autoclaw-page-desc{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-section-surface{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-autoclaw-section-head{display:grid;grid-template-columns:minmax(0,1fr);row-gap:2px;align-items:start}
.dsm-autoclaw-section-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.dsm-autoclaw-section-desc{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-page-body .dsm-autoclaw-usage,.dsm-autoclaw-section-surface .dsm-autoclaw-usage{--dsm-autoclaw-surface:var(--dsw-alias-bg-layer-3,#202126);padding:20px 20px 8px;border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px}
.dsm-autoclaw-usage{--dsm-autoclaw-surface:var(--dsw-alias-bg-layer-1,#17181b);display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px;background:var(--dsw-alias-bg-layer-1,#17181b);border-radius:12px}
/* SCOPE ROW — boxed chips. One cell here because there is one provider. */
.dsm-autoclaw-tabs{display:flex;gap:8px}
.dsm-autoclaw-tab-cell{display:flex;align-items:center;gap:8px;min-width:0;flex:1;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);transition:border-color .15s,background .15s}
.dsm-autoclaw-tab-cell:has(.dsm-autoclaw-tab-active){border-color:var(--dsw-alias-brand-primary,#5686fe);background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-autoclaw-tab{appearance:none;font:inherit;cursor:pointer;flex:1;min-width:0;border:0;border-radius:7px;padding:0;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;background:transparent;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-autoclaw-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-autoclaw-tab-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#777)}
.dsm-autoclaw-tab-dot-ok{background:var(--dsw-alias-state-success-primary,#22c55e)}
.dsm-autoclaw-tab-state{flex:none;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-region-summary{display:flex;flex-direction:column;gap:2px}
.dsm-autoclaw-models-summary{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-model-row-spent{opacity:.55}
.dsm-autoclaw-quota-flag{margin-left:6px;color:var(--dsw-alias-label-caution,#e8b34b);font-size:11px}
.dsm-autoclaw-free-quota-warn{color:var(--dsw-alias-label-caution,#e8b34b)}
.dsm-autoclaw-usage-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ef4444)}
/* SECTION ROW — sticky underlined tabs. */
.dsm-autoclaw-panels{position:sticky;top:-1px;z-index:2;display:flex;align-items:stretch;gap:2px;margin:0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));background:var(--dsm-autoclaw-surface,var(--dsw-alias-bg-layer-3,#202126))}
.dsm-autoclaw-panel-tab{appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;transition:color .15s,border-color .15s}
.dsm-autoclaw-panel-tab:hover:not(.dsm-autoclaw-panel-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-autoclaw-panel-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-autoclaw-panel-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-autoclaw-panel{margin:0}
.dsm-autoclaw-panel[hidden]{display:none!important}
.dsm-autoclaw-panel-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-account-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-autoclaw-section{display:flex;flex-direction:column;gap:12px;margin:0;padding:0 0 4px}
.dsm-autoclaw-account-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
/* Stat cards: the three padded figures both siblings draw. */
.dsm-autoclaw-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:2px}
.dsm-autoclaw-stat{position:relative;display:flex;flex-direction:column;gap:9px;padding:16px 16px 14px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#24262c);overflow:hidden;min-width:0}
.dsm-autoclaw-stat-head{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-autoclaw-stat-badge{margin-left:auto;flex:0 0 auto;padding:2px 8px;border-radius:999px;font-size:11px;line-height:15px;font-weight:600;letter-spacing:.2px;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32)}
.dsm-autoclaw-stat-value{font-size:28px;font-weight:600;line-height:1.15;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6);overflow:hidden;text-overflow:ellipsis}
.dsm-autoclaw-stat-hint{margin:2px 0 0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a8)}
.dsm-autoclaw-stat-value-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
/* Tables. */
.dsm-autoclaw-table{container-type:inline-size;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-autoclaw-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,auto);column-gap:12px;row-gap:4px;align-items:center;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-autoclaw-row:first-child{border-top:0}
.dsm-autoclaw-row-head{padding:8px 14px;row-gap:1px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.dsm-autoclaw-row-head .dsm-autoclaw-col-value{justify-self:end;text-align:right}
.dsm-autoclaw-cell{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsm-autoclaw-name{font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsm-autoclaw-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dsm-autoclaw-value{justify-self:end;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6);white-space:nowrap}
.dsm-autoclaw-value-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-autoclaw-value-dim{color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-current-tag{align-self:center;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#22c55e);border:1px solid rgba(34,197,94,.55);color:#fff;font-size:11px;font-weight:600;line-height:16px;white-space:nowrap}
.dsm-autoclaw-model-table{container-type:inline-size;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-autoclaw-model-row{display:grid;grid-template-columns:minmax(0,1.7fr) .7fr 1fr 1fr 1fr .6fr;gap:10px;align-items:center;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-autoclaw-model-row:first-child{border-top:0}
.dsm-autoclaw-model-row-head{padding:7px 12px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.dsm-autoclaw-model-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsm-autoclaw-model-num{font-variant-numeric:tabular-nums;white-space:nowrap}
/* Diagnostics. */
.dsm-autoclaw-diag{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-autoclaw-diag-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:8px 12px}
.dsm-autoclaw-diag-row+.dsm-autoclaw-diag-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-autoclaw-diag-label{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-autoclaw-diag-value{min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:18px;text-align:right;overflow-wrap:anywhere}
.dsm-autoclaw-diag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsm-autoclaw-diag-bad{color:var(--dsw-alias-label-caution,#e8b34b)}
.dsm-autoclaw-diag-hint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
/* Buttons. */
.dsm-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;min-height:32px;font-size:13px;line-height:20px}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-btn:disabled{opacity:.4;cursor:default}
.dsm-btn-outline{border-color:var(--dsw-alias-border-l2,#36373b);color:var(--dsw-alias-label-secondary,#c6c9d0);background:transparent;font-weight:500}
.dsm-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary,#e6e6e6);border-color:var(--dsw-alias-label-dimmed,#777);background:rgba(255,255,255,.04)}
/* Legacy collapsible card. */
.dsm-plugin-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none}
.dsm-plugin-card-header{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dsm-plugin-card-head{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsm-plugin-card-title{font-size:15px;font-weight:600;line-height:22px}
.dsm-plugin-card-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-plugin-card-chevron{margin-left:auto;width:8px;height:8px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);opacity:.6}
.dsm-plugin-card-chevron-open{transform:rotate(225deg)}
.dsm-plugin-card-body{margin:0 16px;padding:0 0 8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
/* Model picker label. */
.dsm-autoclaw-model-label{display:inline-flex;align-items:center;gap:5px}
.dsm-autoclaw-model-label-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#5686fe);flex:none}
/* Composer trigger: plain text at rest, no border, no fill. */
.dsm-autoclaw-composer-points{display:inline-flex;align-items:center;min-width:0}
.dsm-autoclaw-composer-points-trigger{appearance:none;display:inline-flex;align-items:center;align-self:stretch;padding:2px 6px;border:0;border-radius:6px;background:transparent;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums}
.dsm-autoclaw-composer-points-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-autoclaw-composer-points-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-autoclaw-composer-panel{position:fixed;z-index:1100;box-sizing:border-box;width:min(264px,calc(100vw - 24px));padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:var(--dsw-radius-lg,14px);background:var(--dsw-specific-menu,Canvas);box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.22));backdrop-filter:var(--dsw-menu-backdrop-filter,none);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#444);text-align:left}
.dsm-autoclaw-composer-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.dsm-autoclaw-composer-panel-title{flex:none;white-space:nowrap;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
.dsm-autoclaw-composer-panel-actions{flex:none;margin-left:auto;display:flex;align-items:center;gap:6px}
.dsm-autoclaw-composer-panel-refresh{appearance:none;display:inline-flex;align-items:center;gap:4px;padding:3px 8px 3px 6px;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#444);font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
.dsm-autoclaw-composer-panel-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsm-autoclaw-composer-panel-refresh:disabled{opacity:.5;cursor:default}
.dsm-autoclaw-spin{animation:dsm-autoclaw-spin .8s linear infinite}
@keyframes dsm-autoclaw-spin{to{transform:rotate(360deg)}}
.dsm-autoclaw-composer-panel-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.dsm-autoclaw-composer-panel-table thead th{padding:0 0 7px;font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary,#999);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));text-align:left}
.dsm-autoclaw-composer-panel-table tbody th,.dsm-autoclaw-composer-panel-table tbody td{padding:4px 0;text-align:left;vertical-align:middle}
.dsm-autoclaw-composer-panel-num{text-align:right!important;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsm-autoclaw-composer-panel-row-current th{font-weight:400}
.dsm-autoclaw-composer-panel-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22c55e);margin-right:6px}
.dsm-autoclaw-composer-panel-who{display:inline-flex;align-items:baseline;gap:6px}
.dsm-autoclaw-composer-panel-name{color:var(--dsw-alias-label-primary,CanvasText)}
.dsm-autoclaw-composer-panel-mark{font-size:10px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-composer-panel-note,.dsm-autoclaw-composer-panel-empty{margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-autoclaw-composer-panel-error{margin:0 0 8px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-autoclaw-composer-panel-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));color:var(--dsw-alias-label-tertiary,#999);font-size:11px}
.dsm-autoclaw-composer-panel-settings{appearance:none;border:1px solid transparent;border-radius:999px;padding:3px 8px;background:rgba(86,134,254,.10);color:var(--dsw-alias-brand-primary,#5686fe);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.dsm-autoclaw-composer-panel-settings:hover{background:rgba(86,134,254,.18)}
/* The table narrows against its own container, not the viewport. */
@container (max-width:700px){
  .dsm-autoclaw-row{column-gap:8px;row-gap:3px;padding:9px 12px}
  .dsm-autoclaw-row-head{padding:7px 12px}
  .dsm-autoclaw-model-row{grid-template-columns:minmax(0,1.7fr) .7fr 1fr;gap:6px;padding:9px 12px}
  .dsm-autoclaw-model-row>span:nth-child(4),.dsm-autoclaw-model-row>span:nth-child(5),.dsm-autoclaw-model-row>span:nth-child(6){display:none}
}
`

    function installStyles() {
      if (typeof document === 'undefined') return
      const id = `${NS}/page.css`
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = NS
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------- entry

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        installStyles()
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        const t = ctx.locale.bind(NS)

        const backToConversation = () => {
          const layout = ctx.get?.('layout')
          if (layout === undefined || typeof layout.selectPanel !== 'function') return
          try { layout.selectPanel(null) } catch { /* a stripped layout keeps the panel */ }
        }
        const onOpenPanel = () => {
          const layout = ctx.get?.('layout')
          if (layout === undefined || typeof layout.selectPanel !== 'function') return
          try { layout.selectPanel(PANEL_ID) } catch { /* the main seat may be absent */ }
        }

        // One owner for every disposer: slot failures are contained per entry,
        // and a single effect releases whatever did land on unload.
        const disposers = []
        const registerSlot = (key, describe, register) => {
          try {
            const injected = ctx.slots.inject(key, () => register())
            if (typeof injected === 'function') disposers.push(injected)
          } catch (error) {
            console.error(`[dsh-connect-autoclaw] ${describe} failed (host provider unaffected):`, error)
          }
        }
        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try { dispose() } catch { /* already disposed by the slot service */ }
          }
        })

        const cardInject = (surface) => () => ({
          t,
          surface,
          ...(surface === 'page' ? { backToConversation } : {}),
          onOpenPanel,
        })

        // 1. settings.section (+ its icon, same id, from ONE inject callback).
        //    Trae order is 30, WorkBuddy 35; 30 keeps this beside the other
        //    third-party pages without colliding with a shipped section.
        registerSlot('settings.section', 'settings section page', () => {
          const pageDisposer = ctx.slots.register({
            name: 'settings.section',
            id: PANEL_ID,
            order: 30,
            label: () => t('nav.panel'),
            locale: NS,
            inject: cardInject('section'),
          }, UsageCard)
          let iconDisposer
          try {
            iconDisposer = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
              name: 'settings.section.icon', id: PANEL_ID, locale: NS,
            }, (iconProps) => h(PanelIcon, iconProps)))
          } catch (error) {
            // A host that declares the section but not its icon seat still gets
            // the page; the shell draws its default gear instead.
            console.error('[dsh-connect-autoclaw] settings nav icon failed (page unaffected):', error)
          }
          // One disposer owns both: the glyph is only meaningful while the
          // page's id exists, so they live and die together.
          return () => {
            try { pageDisposer() } catch { /* already disposed by the slot service */ }
            if (typeof iconDisposer === 'function') {
              try { iconDisposer() } catch { /* already disposed */ }
            }
          }
        })

        // 2. Two composer seats, both unconditional, both gated at render.
        for (const [slot, position, order] of [
          ['conversation.input.right', 'composer', 4],
          ['conversation.composer.dock', 'stats', 10],
        ]) {
          registerSlot(slot, `points slot ${slot}`, () => ctx.slots.register({
            name: slot,
            id: `${PANEL_ID}-${position}-points`,
            order,
            locale: NS,
            inject: () => ({ t, position, onOpenPanel }),
          }, ComposerGate))
        }

        // 3. Model-picker label: negative priority avoids the contested 0.
        registerSlot('conversation.input.model.label', 'model label slot', () => {
          let kind
          try { kind = ctx.slots.spec?.('conversation.input.model.label')?.kind } catch { kind = undefined }
          if (kind === 'list' || kind === 'chain') return () => {}
          const seats = kind === 'keyed' && OWN_PROVIDERS.size > 0
            ? [...OWN_PROVIDERS].map((key) => ({ name: 'conversation.input.model.label', key, priority: MODEL_LABEL_PRIORITY }))
            : [{ name: 'conversation.input.model.label', priority: MODEL_LABEL_PRIORITY }]
          const held = []
          try {
            for (const seat of seats) held.push(ctx.slots.register(seat, ModelLabel))
          } catch (error) {
            for (const dispose of held.reverse()) { try { dispose() } catch {} }
            throw error
          }
          return () => { for (const dispose of held) { try { dispose() } catch {} } }
        })

        // 4. The centre-column page, always registered so the readout's
        //    "open panel" control has somewhere to go.
        registerSlot('main', 'main page', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS, inject: cardInject('page'),
        }, UsageCard))

        // 5. Sidebar row, order 2 (below the shipped Plugins row at 0).
        registerSlot('sidebar.panellist', 'sidebar panel row', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 2,
          label: () => t('nav.panel'), locale: NS,
        }, PanelIcon))
      },
    }
  },
})
