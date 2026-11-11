/**
 * Balance & Spend — Client half.
 *
 * Four seats; the only shipped UI this package shadows is the brand wordmark,
 * which it renders itself at a lower slot priority:
 *  - `sidebar.brand.name` (single, priority -10, lower than the shipped
 *    brand-official occupant at 0): the balance chip beside the Harness mark in
 *    the expanded brand row. The collapsed rail renders only the mark, so the
 *    host hides the chip there.
 *  - `sidebar.session.row.trailing` (list): the per-session spend, right after
 *    the row's relative time and before its pin marker, hidden while the
 *    session is cheaper than the configured `minCostToShow`. It deliberately
 *    never takes the 16px leading cell, which belongs to the status dot and the
 *    scheduled-task clock.
 *  - `sidebar.session.row.hover` (list): the exact amount, call count, turn
 *    amount and subagent share in the row's hover card — also the fallback
 *    while hovering, because the host hides trailing icons then.
 *  - `sidebar.footer.action` (list): one line per running session at the sidebar
 *    foot — name, turn/total time and money. A running session's own row cell
 *    is taken by the status spinner, so this is where its money stays visible.
 *
 * Data comes from the Host half's read-only `GET /dsh-balance-spend/state`
 * route (same origin, cookie authenticated), polled while the page is visible.
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-spend',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = new URL('/dsh-balance-spend/state'.replace(/^\/+/, ''), document.baseURI).pathname
    // Echoed by the Host, so `/dsh-balance-spend/state` proves which bundle a
    // page is actually running instead of guessing from cached assets.
    const CLIENT_VERSION = '2026-11-11.1'
    const POLL_MS = 30_000
    const FALLBACK_MIN = 2

    // ---------------------------------------------------------------- store

    const listeners = new Set()
    let current = { status: 'loading', data: null, error: null }
    let inflight = null
    let locale = 'zh'

    const texts = {
      balance: { zh: '账户余额', en: 'Account balance' },
      spend: { zh: '本会话已消耗', en: 'Session spend' },
      calls: { zh: '次调用', en: 'model calls' },
      running: { zh: '运行中', en: 'Running' },
      turn: { zh: '本轮', en: 'Turn' },
      total: { zh: '累计', en: 'Total' },
      subagents: { zh: '其中子代理', en: 'Subagents' },
      untitled: { zh: '新会话', en: 'New session' },
      runningCost: { zh: '运行中会话已消耗', en: 'Spend of running sessions' },
      unavailable: { zh: '余额暂不可用', en: 'Balance unavailable' },
    }

    function translate(key, tag) {
      const entry = texts[key]
      if (!entry) return key
      return tag === 'en' ? entry.en : entry.zh
    }

    function readLocale(ctx) {
      try {
        const active = String(ctx?.get?.('locale')?.getSnapshot?.()?.active ?? '').toLowerCase()
        locale = active.startsWith('en') ? 'en' : 'zh'
      } catch {
        locale = 'zh'
      }
      return locale
    }

    function emit() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error(error)
        }
      }
    }

    function put(next) {
      current = next
      emit()
    }

    function load(force) {
      if (inflight && !force) return inflight
      inflight = (async () => {
        try {
          const response = await fetch(`${ENDPOINT}?client=${encodeURIComponent(CLIENT_VERSION)}&style=${styleMode}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          put({ status: 'ready', data, error: null })
          return data
        } catch (error) {
          put({ status: current.data ? 'stale' : 'error', data: current.data, error: String(error?.message ?? error) })
          return null
        } finally {
          inflight = null
        }
      })()
      return inflight
    }

    function useMeter() {
      const [snapshot, setSnapshot] = React.useState(current)
      React.useEffect(() => {
        const listener = () => setSnapshot(current)
        listeners.add(listener)
        listener()
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return snapshot
    }

    // ------------------------------------------------------------ formatting

    function symbolOf(currency) {
      return String(currency ?? 'CNY').toUpperCase() === 'USD' ? '$' : '¥'
    }

    function fixed(amount, digits) {
      const safe = Number.isFinite(amount) ? amount : 0
      const text = safe.toFixed(digits)
      const [whole, fraction] = text.split('.')
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return fraction ? `${grouped}.${fraction}` : grouped
    }

    /** Keep the leading cell narrow: at most four glyphs including the symbol. */
    function compact(amount) {
      if (amount >= 10) return fixed(amount, 0)
      if (amount >= 1) return fixed(amount, 1)
      return fixed(amount, 2)
    }

    function money(amount, currency, digits = 2) {
      return `${symbolOf(currency)}${fixed(amount, digits)}`
    }

    /** Whole yuan: the footer packs money and two clocks, so decimals go. */
    function yuanOf(amount, currency) {
      const value = Number.isFinite(amount) ? Math.round(amount) : 0
      return `${symbolOf(currency)}${value}`
    }

    /**
     * Minute-granularity duration for the footer: under an hour it reads
     * `42 min`, from an hour up it reads `2H05M`.
     */
    function span(ms) {
      const total = Math.max(0, Number.isFinite(ms) ? ms : 0)
      const minutes = Math.floor(total / 60_000)
      if (minutes < 60) return `${minutes} min`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return `${hours}H${String(rest).padStart(2, '0')}M`
    }

    function entryOf(snapshot, sessionId) {
      const sessions = snapshot?.data?.sessions
      if (!sessions || !sessionId) return null
      const entry = sessions[sessionId]
      return entry && typeof entry.cost === 'number' ? entry : null
    }

    function minOf(snapshot) {
      const value = snapshot?.data?.minCostToShow
      return typeof value === 'number' ? value : FALLBACK_MIN
    }

    /**
     * Delegated work (a subagent a session started) runs under its parent and
     * never owns a sidebar row: the Host flags it from the session header, and
     * an older Carrier still exposes `origin` on the row itself.
     */
    function isSubagentRow(snapshot, session) {
      const row = snapshot?.data?.sessions?.[session?.id]
      if (row && row.subagent === true) return true
      if (session?.origin === 'subagent') return true
      const depth = Number(session?.delegationDepth)
      return Number.isFinite(depth) && depth > 0
    }

    // ------------------------------------------------------------ components

    function BalanceChip() {
      const snapshot = useMeter()
      const balance = snapshot.data?.balance

      if (!balance || !Number.isFinite(balance.amount)) {
        return h('span', {
          className: 'am-balance am-balance-empty',
          title: translate('unavailable', locale),
          onClick: stop,
          onMouseDown: stop,
        })
      }

      return h(
        'span',
        {
          className: 'am-balance',
          title: `${translate('balance', locale)}: ${money(balance.amount, balance.currency)}`,
          onClick: stop,
          onMouseDown: stop,
          role: 'status',
        },
        h('span', { className: 'am-balance-dot' }),
        h('span', { className: 'am-balance-value' }, money(balance.amount, balance.currency)),
      )
    }

    function SessionSpend(props) {
      const snapshot = useMeter()
      const entry = entryOf(snapshot, props.sessionId)
      if (!entry) return null
      const min = minOf(snapshot)
      if (!(entry.cost >= min) || entry.cost <= 0) return null
      const currency = snapshot.data?.currency
      return h(
        'span',
        {
          className: 'am-spend',
          title: `${translate('spend', locale)}: ${money(entry.cost, currency)}`,
        },
        `${symbolOf(currency)}${compact(entry.cost)}`,
      )
    }

    function SessionSpendDetail(props) {
      const snapshot = useMeter()
      const entry = entryOf(snapshot, props.sessionId)
      if (!entry || entry.cost <= 0) return null
      const currency = snapshot.data?.currency
      return h(
        'div',
        { className: 'am-hover-block' },
        h(
          'div',
          { className: 'am-hover' },
          h('span', { className: 'am-hover-label' }, translate('spend', locale)),
          h(
            'span',
            { className: 'am-hover-value' },
            `${money(entry.cost, currency)} · ${entry.calls} ${translate('calls', locale)}`,
          ),
        ),
        entry.turnCost > 0
          ? h(
              'div',
              { className: 'am-hover' },
              h('span', { className: 'am-hover-label' }, translate('turn', locale)),
              h('span', { className: 'am-hover-value' }, money(entry.turnCost, currency)),
            )
          : null,
        entry.children > 0
          ? h(
              'div',
              { className: 'am-hover' },
              h('span', { className: 'am-hover-label' }, translate('subagents', locale)),
              h('span', { className: 'am-hover-value' }, String(entry.children)),
            )
          : null,
      )
    }

    /**
     * Footer list of the sessions running right now, one row each: title plus
     * that session's own spend, so a long run never hides its money.
     *
     * A Session row's leading cell is exclusive: while its status is not idle the
     * shipped row renders `SessionStatusDots` there and this plugin's slot is not
     * even mounted, so the per-row amount cannot survive a run. The sidebar foot
     * is the one always-visible, additive seat; the row's own dot keeps saying
     * "running", this list adds the names and the money.
     */
    function RunningSummary(props) {
      const snapshot = useMeter()
      const useSessions = props?.useSessions
      // The owner passes this hook for the seat's whole lifetime; guarding on it
      // keeps an older Carrier (without the hook) from crashing the sidebar.
      const list = typeof useSessions === 'function' ? useSessions((value) => value) : null
      const byId = list && typeof list === 'object' ? list.byId : null

      const currency = snapshot.data?.currency
      const now = Date.now()
      const rows = []
      if (byId && typeof byId === 'object') {
        for (const id of Object.keys(byId)) {
          const session = byId[id]
          if (!session || session.running !== true) continue
          if (isSubagentRow(snapshot, session)) continue
          const entry = entryOf(snapshot, id)
          const open = entry?.open === true
          // A running round has no final duration yet; count it against the
          // clock here so the number ticks between polls.
          const turnMs =
            open && entry.turnStartAt > 0 ? Math.max(0, now - entry.turnStartAt) : (entry?.turnMs ?? 0)
          rows.push({
            id,
            // The name is optional in this seat and the row is narrow: it stays
            // in the tooltip, the space goes to money and clocks.
            title: String(session.title ?? '').trim() || translate('untitled', locale),
            cost: entry && entry.cost > 0 ? entry.cost : 0,
            turnCost: entry && entry.turnCost > 0 ? entry.turnCost : 0,
            turnMs,
            totalMs: entry?.totalMs ?? 0,
          })
        }
      }
      rows.sort((a, b) => b.cost - a.cost)

      // One shared ticker while any listed round is open, so the durations move
      // between polls; minutes only, so 10 s is fine resolution.
      const ticking = rows.some((row) => entryOf(snapshot, row.id)?.open === true)
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        if (!ticking) return undefined
        const timer = setInterval(() => setTick((value) => value + 1), 10_000)
        return () => clearInterval(timer)
      }, [ticking])

      if (props?.wide === false) return null
      if (rows.length === 0) return null

      return h(
        'div',
        { className: 'am-running', title: translate('runningCost', locale), role: 'status' },
        ...rows.map((row) =>
          h(
            'div',
            { className: 'am-running-item', key: row.id },
            h('span', { className: 'am-running-dot' }),
            h('span', { className: 'am-running-label', title: row.title }, row.title),
            h(
              'span',
              { className: 'am-running-value' },
              h(
                'span',
                { className: 'am-running-turn' },
                `${translate('turn', locale)} ${span(row.turnMs)}/${yuanOf(row.turnCost, currency)}`,
              ),
              h(
                'span',
                { className: 'am-running-total' },
                `${translate('total', locale)} ${span(row.totalMs)}/${yuanOf(row.cost, currency)}`,
              ),
            ),
          ),
        ),
      )
    }

    function stop(event) {
      event.preventDefault()
      event.stopPropagation()
    }

    // ------------------------------------------------------------------ css

    const CSS = `
.am-balance{display:inline-flex;align-items:center;gap:5px;margin-inline-start:6px;padding:1px 7px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;line-height:16px;cursor:default;user-select:none;box-sizing:border-box}
.am-balance-empty{padding:0;border:0;background:none;width:0;margin:0}
.am-balance-dot{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.am-balance-value{white-space:nowrap}
.am-spend{display:inline-flex;align-items:center;flex:none;margin-inline-end:2px;white-space:nowrap;font-size:11px;line-height:14px;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);pointer-events:none;user-select:none}
.am-hover-block{display:flex;flex-direction:column;gap:2px}
.am-hover{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.am-hover-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.am-running{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;padding:1px 4px 3px 8px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:14px;font-variant-numeric:tabular-nums;user-select:none;cursor:default}
.am-running-item{display:flex;align-items:flex-start;gap:6px;min-width:0}
.am-running-dot{width:5px;height:5px;margin-top:4px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none;animation:am-running-pulse 1.4s ease-in-out infinite}
.am-running-label{flex:1 1 auto;min-width:0;max-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-top:1px}
.am-running-value{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:0;font-size:11px;line-height:14px}
.am-running-turn{color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap}
.am-running-total{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:10px}
@keyframes am-running-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}`

    // -------------------------------------------------------------- styles

    let styleMode = 'none'

    /**
     * The `styles` builtin is not present in every Carrier build, and when it is
     * missing the whole stylesheet silently disappears (numbers then render at
     * row-font size, which also defeats any alignment tweak). Fall back to a
     * package-owned <style> tag, the same way shipped third-party plugins do.
     */
    function injectStyles(css) {
      if (typeof styles !== 'undefined' && typeof styles.insert === 'function') {
        styleMode = 'api'
        return styles.insert(css)
      }
      if (typeof document === 'undefined' || !document.head) return () => {}
      const tagId = 'balance-spend/client.css'
      const selector = `style[data-plugin-css="${tagId}"]`
      let tag = document.querySelector(selector)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'balance-spend'
        tag.dataset.pluginCss = tagId
        tag.textContent = css
        document.head.appendChild(tag)
      }
      styleMode = 'dom'
      return () => {
        if (tag?.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    // -------------------------------------------------------------- registration

    return {
      inject: ['slots'],
      apply(ctx) {
        readLocale(ctx)
        ctx.effect(() => injectStyles(CSS), 'balance-spend:stylesheet')

        const locales = ctx.get('locale')
        if (locales && typeof locales.subscribe === 'function') {
          ctx.effect(
            () => locales.subscribe(() => {
              readLocale(ctx)
              emit()
            }),
            'balance-spend:locale',
          )
        }

        ctx.effect(() => {
          let stopped = false
          let timer = null
          // The Host echoes its `refreshSeconds` config, so the poll cadence is
          // configurable instead of compiled in: read it after every round.
          const schedule = () => {
            if (stopped) return
            const seconds = Number(current.data?.refreshSeconds)
            const delay = Number.isFinite(seconds) && seconds >= 2 ? seconds * 1000 : POLL_MS
            timer = setTimeout(() => {
              if (!stopped && !document.hidden) load(true)
              schedule()
            }, delay)
          }
          const onVisible = () => {
            if (!document.hidden) load(true)
          }
          load()
          schedule()
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            stopped = true
            if (timer !== null) clearTimeout(timer)
            document.removeEventListener('visibilitychange', onVisible)
          }
        }, 'balance-spend:poll')

        // The brand row's single name seat: -10 outranks the shipped wordmark
        // (priority 0) without an equal-priority conflict.
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.register({ name: 'sidebar.brand.name', priority: -10 }, BalanceChip),
        )

        // The leading 16px cell already carries the schedule clock on sessions
        // with a scheduled task, so the amount lives beside the row's time
        // label instead of competing for that cell.
        ctx.slots.inject('sidebar.session.row.trailing', () =>
          ctx.slots.register(
            { name: 'sidebar.session.row.trailing', id: 'balance-spend-row', order: 50, label: 'Session spend' },
            SessionSpend,
          ),
        )

        ctx.slots.inject('sidebar.session.row.hover', () =>
          ctx.slots.register(
            { name: 'sidebar.session.row.hover', id: 'balance-spend-row', order: 50, label: 'Session spend detail' },
            SessionSpendDetail,
          ),
        )

        // Running sessions keep their money here: the row's own leading cell is
        // taken by the shipped status dot while a session is not idle.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'balance-spend-running', order: 50, label: 'Running session spend' },
            RunningSummary,
          ),
        )

        console.log('[balance-spend] registered balance chip, session spend and running summary seats')
      },
    }
  },
})
