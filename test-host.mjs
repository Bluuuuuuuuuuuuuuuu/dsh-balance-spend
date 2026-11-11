// Headless test for balance-spend's Host half: drives the real meter object with
// a fake Sessions store, so the money/turn/clock fold is checked without a live
// Harness. Run: node test-host.mjs
import assert from 'node:assert'
import { createMeter } from './index.js'

const now = Date.now()

function assistant(seq, time, model, usage) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-account', model } },
      usage,
    },
  }
}

const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

const events = [
  { type: 'turn/start', seq: 1, time: now - 120_000, data: { turn: 1 } },
  assistant(2, now - 100_000, 'deepseek-flash', usage), // ¥2 (cacheMiss 2 / 1M)
  { type: 'turn/end', seq: 3, time: now - 90_000, data: { turn: 1 } }, // 30 s round
  { type: 'turn/start', seq: 4, time: now - 5_000, data: { turn: 2 } },
]

const sessions = [
  {
    id: 'session-root',
    header: { id: 'session-root', title: 'root' },
    seq: events.length,
    snapshotEvents: (from = 0) => events.slice(from),
  },
  {
    id: 'session-child',
    header: { id: 'session-child', parentSession: 'session-root', origin: 'subagent', delegationDepth: 1 },
    seq: 2,
    snapshotEvents: (from = 0) =>
      [
        { type: 'turn/start', seq: 1, time: now - 4_000, data: { turn: 1 } },
        assistant(2, now - 3_000, 'deepseek-flash', usage),
      ].slice(from),
  },
]

const ctx = {
  get(name) {
    if (name === 'sessions') return { list: () => sessions }
    if (name === 'deepseekAccount')
      return { getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '42.5' }] }) }
    return undefined
  },
}

const meter = createMeter({ minCostToShow: 2 }, ctx)
meter.refreshLive()
await meter.refreshBalance(true)
const data = meter.snapshot()

const root = data.sessions['session-root']
assert.equal(root.cost, 4, 'two model calls, ¥2 each, folded into the parent')
assert.equal(root.calls, 2)
assert.equal(root.children, 1, 'the subagent is merged into the root row')
assert.equal(root.subagent, false)
assert.equal(root.open, true, 'the newest turn has not ended')
assert.ok(root.turnCost > 1.9 && root.turnCost < 2.1, `turn money is the open round only, got ${root.turnCost}`)
assert.equal(root.totalMs >= 30_000 + 4_000, true, `closed round plus the running one, got ${root.totalMs}`)
assert.ok(
  root.turnMs >= 4_000 && root.turnMs <= 20_000,
  `open round is timed against the clock (or the child's round), got ${root.turnMs}`,
)
assert.equal(data.balance.amount, 42.5)
assert.equal(data.currency, 'CNY')
assert.equal(data.minCostToShow, 2)

// Subagents are never their own row in the sidebar.
assert.equal(Object.keys(data.sessions).length, 2)

console.log('host test ok:', {
  cost: root.cost,
  turnCost: root.turnCost,
  turnMs: root.turnMs,
  totalMs: root.totalMs,
  children: root.children,
  balance: data.balance,
})
