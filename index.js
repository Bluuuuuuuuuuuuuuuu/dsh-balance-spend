/**
 * Account meter — Host half.
 *
 * Two jobs:
 *  1. Read the account balance from the `deepseekAccount` service.
 *  2. Fold every session's `assistant/message` usage into a CNY cost.
 *
 * Both are served over one read-only exact route (`GET /dsh-balance-spend/state`)
 * that the Client half polls; there is no Client→Host RPC dependency and no
 * session event subscription — live sessions are folded incrementally through
 * `Session.snapshotEvents(fromSeq)` and persisted sessions through the
 * `sessionQuery` service, cached by the persistence revision.
 *
 * Tunables live in the Loader entry config (see cordis.patch.yml):
 *
 *   - insert:
 *       - id: balance-spend
 *         name: 'dsh-balance-spend'
 *         config:
 *           minCostToShow: 2      # CNY; a session cheaper than this shows nothing
 *           currency: CNY
 *           refreshSeconds: 30
 *           balanceTtlSeconds: 60
 *           pricing:              # CNY per 1M tokens, keyed "provider/model", "model" or "provider/*"
 *             deepseek-account/deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
 *             claude/default: { cacheHit: 2.15, cacheMiss: 21.5, cacheWrite: 26.9, output: 107 }
 */

export const name = 'balance-spend'

const ROUTE_PATH = '/dsh-balance-spend/state'

/**
 * CNY per 1M tokens. A key is `provider/model`, a bare `model`, or
 * `provider/*`; the first match wins, so a Session that ran on another
 * provider (Claude, a gateway, a local model) is never silently billed at
 * DeepSeek rates.
 *
 * Claude entries are Anthropic list prices (USD per 1M tokens: $3/$15 input/
 * output, cache read 0.1x, cache write 1.25x for Sonnet) converted at ~7.15.
 * Override them in `config.pricing` for a different contract or exchange rate.
 */
const DEFAULT_PRICING = {
  'deepseek-account/deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 },
  'deepseek-account/deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 },
  'claude/default': { cacheHit: 2.15, cacheMiss: 21.5, cacheWrite: 26.9, output: 107 },
  'claude/sonnet': { cacheHit: 2.15, cacheMiss: 21.5, cacheWrite: 26.9, output: 107 },
  'claude/opus': { cacheHit: 10.7, cacheMiss: 107, cacheWrite: 134, output: 536 },
  'claude/haiku': { cacheHit: 0.72, cacheMiss: 7.2, cacheWrite: 9, output: 36 },
}

const DEFAULTS = {
  minCostToShow: 2,
  currency: 'CNY',
  refreshSeconds: 30,
  balanceTtlSeconds: 60,
  coldSessionsPerPass: 200,
  pricing: null,
}

function toNumber(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizePricing(raw) {
  const pricing = { ...DEFAULT_PRICING }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue
      const name = key.trim().toLowerCase()
      if (!name) continue
      const cacheMiss = toNumber(value.cacheMiss, DEFAULT_PRICING['deepseek-flash'].cacheMiss)
      pricing[name] = {
        cacheHit: toNumber(value.cacheHit, DEFAULT_PRICING['deepseek-flash'].cacheHit),
        cacheMiss,
        cacheWrite: toNumber(value.cacheWrite, cacheMiss),
        output: toNumber(value.output, DEFAULT_PRICING['deepseek-flash'].output),
      }
    }
  }
  return pricing
}

export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  return {
    minCostToShow: Math.max(0, toNumber(input.minCostToShow, DEFAULTS.minCostToShow)),
    currency: String(input.currency ?? DEFAULTS.currency).toUpperCase(),
    refreshSeconds: Math.min(3600, Math.max(5, toNumber(input.refreshSeconds, DEFAULTS.refreshSeconds))),
    balanceTtlSeconds: Math.min(3600, Math.max(10, toNumber(input.balanceTtlSeconds, DEFAULTS.balanceTtlSeconds))),
    coldSessionsPerPass: Math.min(2000, Math.max(1, Math.round(toNumber(input.coldSessionsPerPass, DEFAULTS.coldSessionsPerPass)))),
    pricing: normalizePricing(input.pricing),
  }
}

const warnedPricing = new Set()

/** Most expensive configured rate, used when a provider has no entry at all. */
function priciest(pricing) {
  let best = null
  for (const [key, value] of Object.entries(pricing)) {
    if (key === 'default' || !value) continue
    if (!best || value.cacheMiss > best.cacheMiss) best = value
  }
  return best ?? DEFAULT_PRICING['claude/default']
}

/**
 * Resolve `provider/model` -> price. Order: exact pair, exact model,
 * `provider/*`, Claude family (`claude/sonnet` …), configured `default`,
 * then the priciest entry so an unknown provider is never reported as cheap.
 */
function priceFor(pricing, provider, model) {
  const prov = String(provider ?? '').trim().toLowerCase()
  const name = String(model ?? '').trim().toLowerCase()
  const pair = prov && name ? `${prov}/${name}` : ''
  if (pair && pricing[pair]) return pricing[pair]
  if (name && pricing[name]) return pricing[name]
  if (prov && pricing[`${prov}/*`]) return pricing[`${prov}/*`]
  if (prov === 'claude' || name.includes('claude')) {
    for (const family of ['sonnet', 'opus', 'haiku']) {
      if (name.includes(family) && pricing[`claude/${family}`]) return pricing[`claude/${family}`]
    }
    if (pricing['claude/default']) return pricing['claude/default']
  }
  if (pricing.default) return pricing.default
  if (!prov && !name) return pricing['deepseek-flash'] ?? priciest(pricing)
  const label = `${prov || '?'}/${name || '?'}`
  if (!warnedPricing.has(label)) {
    warnedPricing.add(label)
    console.warn(`[balance-spend] no price for "${label}"; assuming the priciest configured rate`)
  }
  return priciest(pricing)
}

/**
 * `usage.inputTokens` counts uncached input only; cache reads and cache writes
 * are reported separately, so the three input classes are summed independently.
 */
export function costOfUsage(usage, provider, model, pricing) {
  if (!usage || typeof usage !== 'object') return 0
  const price = priceFor(pricing, provider, model)
  const miss = toNumber(usage.inputTokens, 0)
  const hit = toNumber(usage.cacheReadTokens, 0)
  const write = toNumber(usage.cacheWriteTokens, 0)
  const output = toNumber(usage.outputTokens, 0)
  const writePrice = price.cacheWrite ?? price.cacheMiss
  return (miss * price.cacheMiss + hit * price.cacheHit + write * writePrice + output * price.output) / 1_000_000
}

/**
 * Cheap token estimate for streamed text. A model call reports its real `usage`
 * only when it lands, so the streamed deltas are the only live progress signal a
 * running round has. Wide scripts (CJK) cost about one token per character,
 * latin text about four characters per token; the provider's usage replaces
 * this as soon as the call commits.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let wide = 0
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0x2e80) wide += 1
  }
  const narrow = Math.max(0, text.length - wide)
  return Math.ceil(wide + narrow / 4)
}

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** A finite number from a log field, or the fallback (log times are epoch ms). */
function numberOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : fallback
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
}

/**
 * A Session started by another Session (a delegate / subagent) never gets its
 * own sidebar row: its header marks `origin: 'subagent'` and a delegation
 * depth. Its spend stays its own log's business, so the running list hides it
 * instead of showing one row per subagent under the same task.
 */
export function isSubagentHeader(header) {
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  const depth = Number(header.delegationDepth)
  return Number.isFinite(depth) && depth > 0
}

export function createMeter(rawConfig, ctx) {
  const config = normalizeConfig(rawConfig)
  const pricing = config.pricing

  /** sessionId -> { seq, cost, calls, turnStart } folded incrementally while the session is live. */
  const live = new Map()
  /** sessionId -> { stamp, cost, calls, turnStart } folded once per persistence revision. */
  const cold = new Map()
  /**
   * sessionId -> { at, count }. A read can fail while the query corpus is still
   * warming up after a restart, so a failure only parks the session for a while
   * instead of hiding it forever.
   */
  const coldFailures = new Map()
  /**
   * sessionId -> { provider, model, tokens, usage, at }. The newest model call
   * that is still streaming: the loop only appends its `usage` when the call
   * lands, so until then this is the only live progress a running round has.
   */
  const streams = new Map()
  /** sessionId -> { at, tokens }. `tokenMeter.measure` is O(surface), so cache it. */
  const promptCache = new Map()

  let balance = null
  let balanceAt = 0
  let lastRefresh = 0
  let lastClient = null
  let inflight = null

  /**
   * Delegated sessions (a subagent a Session started) are hidden from the
   * session list; see `isSubagentHeader`.
   */
  const isSubagent = (header) => isSubagentHeader(header)

  /** The live `Session` behind an id, when the session store still holds it. */
  function sessionOf(id) {
    const store = ctx.get('sessions')
    if (typeof store?.get !== 'function') return null
    try {
      return store.get(id) ?? null
    } catch {
      return null
    }
  }

  /** The provider/model the next call of a session is routed to. */
  function routeOf(session) {
    const context = typeof session?.requestContext === 'function' ? session.requestContext() : null
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : null
    const call = header?.config
    return {
      provider: String(context?.provider ?? call?.provider ?? ''),
      model: String(context?.model ?? call?.model ?? ''),
    }
  }

  /**
   * Follow one assistant stream. A chunk carries no money, but its deltas are
   * tokens the provider will bill, and some providers publish a `usage` chunk
   * before the stream ends — that, when present, is exact.
   */
  function observeStream(payload) {
    const id = payload?.agent?.id
    const frame = payload?.frame
    if (!id || !frame || typeof frame !== 'object') return
    if (frame.type === 'end') {
      streams.delete(id)
      return
    }
    let record = streams.get(id)
    if (!record) {
      const route = routeOf(sessionOf(id))
      record = { provider: route.provider, model: route.model, tokens: 0, usage: null, at: Date.now() }
      streams.set(id, record)
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (!chunk || typeof chunk !== 'object') return
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      record.tokens += estimateTokens(String(chunk.text ?? ''))
    } else if (chunk.type === 'tool-call-delta') {
      record.tokens += estimateTokens(String(chunk.argumentsDelta ?? ''))
    } else if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
      record.usage = chunk.usage
    }
    record.at = Date.now()
  }

  /** The harness's own estimate of the prompt the next call will send. */
  function promptTokens(id, session) {
    const meter = ctx.get('tokenMeter')
    if (typeof meter?.measure !== 'function' || !session) return 0
    const now = Date.now()
    const cached = promptCache.get(id)
    if (cached && now - cached.at < 3000) return cached.tokens
    let measured = 0
    try {
      measured = numberOr(meter.measure(session)?.totalTokens, 0)
    } catch {
      measured = 0
    }
    const tokens = measured > 0 ? measured : 0
    promptCache.set(id, { at: now, tokens })
    return tokens
  }

  /**
   * Money for the model call that is in flight right now. The prompt is priced
   * with the cache-hit mix of the session's previous call (a continuation is
   * mostly cache reads), the streamed output at the output rate. Returns 0 when
   * nothing is streaming; the row is flagged `estimated` so the Client can show
   * the number as a projection rather than a logged charge.
   */
  function estimateOpenTurn(id, entry) {
    const stream = streams.get(id)
    if (!stream) return 0
    // A stream silent for minutes belongs to an attempt that is gone.
    if (Date.now() - stream.at > 120_000) {
      streams.delete(id)
      return 0
    }
    if (stream.usage && typeof stream.usage === 'object') {
      return costOfUsage(stream.usage, stream.provider, stream.model, pricing)
    }
    const session = sessionOf(id)
    const route = stream.provider || stream.model ? stream : routeOf(session)
    const price = priceFor(pricing, route.provider, route.model)
    const prompt = promptTokens(id, session)
    const mix = Math.max(0, Math.min(1, numberOr(entry?.mix, 0)))
    const miss = prompt * (1 - mix)
    const hit = prompt * mix
    const output = Math.max(0, numberOr(stream.tokens, 0))
    return (miss * price.cacheMiss + hit * price.cacheHit + output * price.output) / 1_000_000
  }

  function foldEvent(entry, event) {
    if (!event || typeof event !== 'object') return
    // A new turn opens with `turn/start`; snapshotting the running total there
    // is what makes "this turn" and "whole session" separable in one pass. It
    // works for cold logs too, where every turn arrives in order.
    if (event.type === 'turn/start') {
      entry.turnStart = entry.cost
      entry.open = true
      // Wall-clock start of the open turn, so a running round can be timed
      // without the Client having to know anything else about the log.
      entry.turnStartAt = numberOr(event.time, Date.now())
      return
    }
    // `turn/end` closes the round: its duration is final and joins the running
    // session total. Until then the turn's first model call is still in
    // flight, so "this round" money is legitimately 0.
    if (event.type === 'turn/end') {
      if (entry.open && entry.turnStartAt > 0) {
        const ms = Math.max(0, numberOr(event.time, Date.now()) - entry.turnStartAt)
        entry.turnMs = ms
        entry.totalMs += ms
      }
      entry.open = false
      return
    }
    if (event.type !== 'assistant/message') return
    const data = event.data
    if (!data || typeof data !== 'object') return
    const usage = data.usage
    if (!usage || typeof usage !== 'object') return
    const source = data.message?.source ?? {}
    entry.cost += costOfUsage(usage, source.provider, source.model, pricing)
    // Cache-hit share of this call's prompt: the next call of the same session
    // looks much the same, so an in-flight estimate can price its prompt without
    // assuming every token is a cache miss.
    const miss = numberOr(usage.inputTokens, 0)
    const hit = numberOr(usage.cacheReadTokens, 0)
    if (miss + hit > 0) entry.mix = hit / (miss + hit)
    // One `assistant/message` is one model call; `data.turn` restarts per run,
    // so it cannot count how much work a Session has done.
    entry.calls += 1
  }

  function refreshLive() {
    const store = ctx.get('sessions')
    if (typeof store?.list !== 'function') return
    let sessions
    try {
      sessions = store.list()
    } catch {
      return
    }
    if (!Array.isArray(sessions)) return
    for (const session of sessions) {
      const id = session?.header?.id ?? session?.id
      if (!id) continue
      let entry = live.get(id)
      if (!entry) {
        entry = {
          seq: 0,
          cost: 0,
          calls: 0,
          turnStart: 0,
          turnStartAt: 0,
          turnMs: 0,
          totalMs: 0,
          open: false,
          // Cache-hit share of the prompt, learned from the previous call.
          mix: 0,
          subagent: isSubagent(session?.header),
          parentId: session?.header?.parentSession ?? null,
        }
        live.set(id, entry)
      }
      const from = entry.seq
      let events = []
      try {
        events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(from) : []
      } catch {
        events = []
      }
      if (Array.isArray(events)) {
        for (const event of events) foldEvent(entry, event)
        // The call's real usage just landed: drop its stream estimate so the
        // same money is never counted twice.
        if (events.some((event) => event?.type === 'assistant/message')) streams.delete(id)
        if (events.length > 0) entry.seq = from + events.length
      }
      const seq = typeof session.seq === 'number' ? session.seq : null
      if (seq !== null && seq > entry.seq) entry.seq = seq
    }
  }

  async function readAll(query, persistence, id) {
    if (typeof query?.readSession === 'function') {
      const result = await query.readSession(id)
      return Array.isArray(result?.events) ? result.events : []
    }
    if (typeof persistence?.open === 'function') {
      const handle = await persistence.open(id, 'read')
      try {
        const events = []
        let offset = 0
        for (let page = 0; page < 1000; page += 1) {
          const chunk = await handle.read(offset, 500)
          const batch = Array.isArray(chunk?.events) ? chunk.events : []
          if (batch.length === 0) break
          for (const event of batch) events.push(event)
          offset += batch.length
        }
        return events
      } finally {
        try {
          await handle.close()
        } catch {
          /* the handle is already closed */
        }
      }
    }
    return []
  }

  async function refreshCold(budget) {
    const query = ctx.get('sessionQuery')
    const persistence = ctx.get('sessionPersistence')
    let records = null
    if (typeof query?.listSessions === 'function') {
      try {
        records = await query.listSessions()
      } catch {
        records = null
      }
    }
    if (!Array.isArray(records) && typeof persistence?.list === 'function') {
      try {
        records = await persistence.list()
      } catch {
        records = null
      }
    }
    if (!Array.isArray(records)) return

    const now = Date.now()
    let remaining = budget
    for (const record of records) {
      if (remaining <= 0) break
      const header = record?.header ?? record
      const id = header?.id
      if (!id) continue
      const liveEntry = live.get(id)
      if (liveEntry && (record?.live === true || record?.persisted == null)) continue

      const snapshot = record?.persisted ?? record
      const stamp = `${String(snapshot?.revision ?? '')}|${String(snapshot?.eventCount ?? '')}`
      const cached = cold.get(id)
      if (cached && cached.stamp === stamp) continue

      const failure = coldFailures.get(id)
      if (failure && failure.count >= 3 && now - failure.at < 60_000) continue

      remaining -= 1
      try {
        const events = await readAll(query, persistence, id)
        const entry = {
          stamp,
          cost: 0,
          calls: 0,
          turnStart: 0,
          turnStartAt: 0,
          turnMs: 0,
          totalMs: 0,
          open: false,
          mix: 0,
          subagent: isSubagent(header),
          parentId: header?.parentSession ?? null,
        }
        for (const event of events) foldEvent(entry, event)
        cold.set(id, entry)
        coldFailures.delete(id)
        // A finished session is reported by the cold pass; drop the live tail.
        if (!record?.live) live.delete(id)
      } catch {
        const previous = coldFailures.get(id)
        coldFailures.set(id, { at: now, count: (previous?.count ?? 0) + 1 })
      }
    }
  }

  async function refreshBalance(force) {
    const account = ctx.get('deepseekAccount')
    if (typeof account?.getBalance !== 'function') return
    if (!force && Date.now() - balanceAt < config.balanceTtlSeconds * 1000) return
    let value = null
    try {
      value = await account.getBalance({
        version: '1.0.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
    } catch (error) {
      console.warn(`[balance-spend] balance unavailable: ${error?.message ?? error}`)
    }
    balanceAt = Date.now()
    if (!value || value.status !== 'ready') return

    const wallets = [...(value.value ?? []), ...(value.bonusWallets ?? [])]
    const totals = new Map()
    for (const wallet of wallets) {
      const code = String(wallet?.currency ?? config.currency).toUpperCase()
      const amount = Number.parseFloat(String(wallet?.balance ?? '0'))
      if (!Number.isFinite(amount)) continue
      totals.set(code, (totals.get(code) ?? 0) + amount)
    }
    const code = totals.has(config.currency) ? config.currency : [...totals.keys()][0]
    if (!code) return
    balance = { currency: code, amount: round(totals.get(code), 4) }
  }

  function snapshot() {
    const sessions = {}
    const rows = new Map()
    const now = Date.now()
    const collect = (id, entry) => {
      // A turn that has not ended yet has no final duration; measure it against
      // the clock so the Client can show the round ticking.
      const open = entry.open === true
      const runningTurnMs = open && entry.turnStartAt > 0 ? Math.max(0, now - entry.turnStartAt) : 0
      rows.set(id, {
        cost: entry.cost,
        calls: entry.calls,
        // Money spent since the newest `turn/start` — the current round, not the
        // whole Session log.
        turnCost: Math.max(0, entry.cost - entry.turnStart),
        // Duration of the newest round (still running counts up to `now`) and
        // the summed duration of the rounds that already closed.
        turnMs: open ? runningTurnMs : entry.turnMs,
        turnStartAt: open ? entry.turnStartAt : 0,
        totalMs: entry.totalMs + runningTurnMs,
        open,
        subagent: entry.subagent === true,
        parentId: entry.parentId ?? null,
        children: 0,
      })
    }
    for (const [id, entry] of cold) collect(id, entry)
    // A live tail is always fresher than the last cold fold of the same session.
    for (const [id, entry] of live) collect(id, entry)

    // A call that is still streaming has no logged `usage` yet, so the first
    // money of a round would read 0 for the whole flight. Add the streamed
    // estimate to the row and mark it, so a running round ticks instead of
    // sitting at zero; the logged usage replaces it the moment the call lands.
    for (const [id, row] of rows) {
      if (!row.open) continue
      const estimate = estimateOpenTurn(id, live.get(id) ?? cold.get(id))
      if (!(estimate > 0)) continue
      row.cost += estimate
      row.turnCost += estimate
      row.estimated = true
    }

    // A delegated Session has no row of its own: its money is billed to the
    // Session that started it, which is the row the sidebar actually shows.
    const rootOf = (id) => {
      const seen = new Set()
      let current = id
      while (current && !seen.has(current)) {
        seen.add(current)
        const row = rows.get(current)
        if (!row) return null
        if (!row.subagent) return current
        current = row.parentId
      }
      return null
    }
    for (const [id, row] of rows) {
      if (!row.subagent) continue
      const rootId = rootOf(id)
      if (!rootId || rootId === id) continue
      const root = rows.get(rootId)
      root.cost += row.cost
      root.calls += row.calls
      root.turnCost += row.turnCost
      // Delegates run alongside their parent, so wall time is the longest of
      // the two rounds, while closed-round time simply adds up.
      root.turnMs = Math.max(root.turnMs, row.turnMs)
      root.totalMs += row.totalMs
      root.open = root.open || row.open === true
      root.estimated = root.estimated === true || row.estimated === true
      root.children += 1
    }

    for (const [id, row] of rows) {
      sessions[id] = {
        cost: round(row.cost, 4),
        calls: row.calls,
        turnCost: round(row.turnCost, 4),
        // Newest round duration and the summed duration of closed rounds, both
        // in milliseconds; the Client formats them as hh:mm:ss.
        turnMs: row.turnMs,
        turnStartAt: row.turnStartAt,
        totalMs: row.totalMs,
        // True while the newest turn has not ended yet (its money lands later).
        open: row.open === true,
        // True when part of the money is the in-flight stream estimate, not a
        // logged charge: the Client prefixes it instead of claiming precision.
        estimated: row.estimated === true,
        // Kept so the Client can skip delegated rows even before the merge.
        subagent: row.subagent,
        // How many delegated Sessions are folded into this row's numbers.
        children: row.children,
        // The Session that started this one, when it is a delegate.
        parentId: row.parentId,
      }
    }
    return {
      currency: config.currency,
      minCostToShow: config.minCostToShow,
      refreshSeconds: config.refreshSeconds,
      balance,
      sessions,
      client: lastClient,
      updatedAt: lastRefresh,
    }
  }

  function ensureRefresh() {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        refreshLive()
        await refreshBalance(false)
        await refreshCold(config.coldSessionsPerPass)
      } catch (error) {
        console.warn(`[balance-spend] refresh failed: ${error?.message ?? error}`)
      } finally {
        lastRefresh = Date.now()
        inflight = null
      }
    })()
    return inflight
  }

  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    if (String(req.headers?.['sec-fetch-site'] ?? '') === 'cross-site') {
      sendJson(res, 403, { error: 'cross-site-request-refused' })
      return
    }
    // The Client tags its polls with its bundle version, so a page running a
    // stale bundle is visible in the payload instead of being guessed at.
    try {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams
      const client = params.get('client')
      const style = params.get('style')
      if (client) lastClient = `${client.slice(0, 40)}${style ? `+${style.slice(0, 12)}` : ''}`
    } catch {
      /* malformed request URL */
    }
    await Promise.race([ensureRefresh(), delay(1500)])
    sendJson(res, 200, snapshot())
  }

  return {
    config,
    handle,
    snapshot,
    ensureRefresh,
    refreshLive,
    refreshBalance,
    refreshCold,
    observeStream,
    state: { live, cold, get balance() { return balance } },
  }
}

export function apply(ctx, rawConfig) {
  const meter = createMeter(rawConfig, ctx)

  // The assistant stream is the only live signal of a call that has not landed
  // yet; following it lets a running round show a moving estimate.
  ctx.effect(
    () => ctx.on('agent/assistant-stream', (payload) => meter.observeStream(payload)),
    'balance-spend:stream',
  )

  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer ?? ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      console.warn('[balance-spend] webServer is unavailable; the meter route was not registered')
      return
    }
    hostCtx.effect(() => {
      const dispose = webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: meter.handle })
      return () => {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }, 'balance-spend:route')
  })

  // Warm the cache so the first Client poll already has every session. A
  // restart leaves the query corpus cold, so retry a few rounds before giving
  // up; `ensureRefresh` is idempotent and dedupes concurrent runs.
  void (async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await meter.ensureRefresh()
      await delay(250)
    }
  })()
}

export const __test = { normalizeConfig, costOfUsage, priceFor, isSubagentHeader, estimateTokens }
