// Headless smoke test for balance-spend's Client half: loads client.js in a vm
// sandbox with the documented ModuleLoader/builtin surface, applies it to a
// fake Slots service, and renders each registered component once.
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert'

const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8')

const registrations = []
let spec = null

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

const sandbox = {
  console,
  URL,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      currency: 'CNY',
      minCostToShow: 2,
      refreshSeconds: 30,
      balance: { currency: 'CNY', amount: 86.1182 },
      sessions: {
        'session-rich': {
          cost: 6.4847,
          calls: 492,
          turnCost: 3.44,
          turnMs: 75_000,
          totalMs: 3_930_000,
          open: false,
          subagent: false,
          children: 2,
        },
        'session-poor': {
          cost: 0.5,
          calls: 3,
          turnCost: 0.5,
          turnMs: 4_000,
          totalMs: 4_000,
          open: false,
          subagent: false,
          children: 0,
        },
        'session-agent': { cost: 4.2, calls: 40, turnCost: 1.1, turnMs: 0, totalMs: 0, subagent: true, children: 0 },
        'session-est': {
          cost: 3.2,
          calls: 12,
          turnCost: 3.2,
          turnMs: 0,
          totalMs: 0,
          open: true,
          // The in-flight stream estimate: money that is not a logged charge yet.
          estimated: true,
          subagent: false,
          children: 0,
        },
        'session-fresh': {
          cost: 0,
          calls: 0,
          turnCost: 0,
          turnMs: 0,
          totalMs: 0,
          turnStartAt: Date.now() - 4_000,
          open: true,
          subagent: false,
          children: 0,
        },
      },
      updatedAt: Date.now(),
    }),
  }),
  document: {
    baseURI: 'http://127.0.0.1:42849/',
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  },
  styles: { insert: () => () => {} },
  window: {
    __ModuleLoader__: {
      load(next) {
        spec = next
      },
    },
  },
}

sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

assert.ok(spec, 'the bundle must register a module spec')
assert.equal(spec.id, 'dsh-balance-spend')

const module_ = spec.factory((id) => {
  assert.equal(id, 'react')
  return React
})
assert.deepEqual(module_.inject, ['slots'])

const effects = []
const ctx = {
  get(name) {
    if (name === 'locale') return { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }
    return undefined
  },
  effect(callback, label) {
    effects.push(label)
    return callback() ?? (() => {})
  },
  slots: {
    inject(ownerKey, contribute) {
      const dispose = contribute()
      return dispose ?? (() => {})
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

module_.apply(ctx)

await new Promise((resolve) => setTimeout(resolve, 10))

const bySlot = (name) => registrations.find((entry) => entry.options.name === name)

assert.equal(registrations.length, 4, 'four seats are registered')
const chip = bySlot('sidebar.brand.name')
assert.ok(chip, 'the brand-name seat is taken')
assert.equal(chip.options.priority, -10)
assert.equal(chip.options.id, undefined, 'single slots take no id')

const row = bySlot('sidebar.session.row.trailing')
assert.ok(row)
assert.equal(row.options.name, 'sidebar.session.row.trailing')

const hover = bySlot('sidebar.session.row.hover')
assert.ok(hover)

const chipTree = chip.component({})
assert.equal(chipTree.props.className, 'am-balance')
const text = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(text).join(''))
assert.equal(text(chipTree), '¥86.12')
assert.match(chipTree.props.title, /账户余额/)

const rich = registrations.find((entry) => entry.options.name === 'sidebar.session.row.trailing').component({
  sessionId: 'session-rich',
})
assert.equal(rich.props.className, 'am-spend')
assert.equal(text(rich), '¥6.5')

const poor = registrations.find((entry) => entry.options.name === 'sidebar.session.row.trailing').component({
  sessionId: 'session-poor',
})
assert.equal(poor, null, 'below the threshold nothing is rendered')

const estimated = registrations.find((entry) => entry.options.name === 'sidebar.session.row.trailing').component({
  sessionId: 'session-est',
})
assert.equal(text(estimated), '≈¥3.2', 'money from the live stream is marked as an estimate')

const detail = registrations.find((entry) => entry.options.name === 'sidebar.session.row.hover').component({
  sessionId: 'session-rich',
})
assert.match(text(detail), /¥6\.48/)
assert.match(text(detail), /492/)
assert.match(text(detail), /次调用/)

// Footer summary: only running sessions, only in the wide column.
const footer = bySlot('sidebar.footer.action')
assert.ok(footer, 'the sidebar foot gets the running summary')
assert.equal(footer.options.id, 'balance-spend-running')
assert.equal(footer.component({ wide: false }), null, 'hidden in the 56px rail')
assert.equal(footer.component({ wide: true }), null, 'nothing to show without a running session')

const useSessions = (selector) =>
  selector({
    ids: ['session-rich', 'session-poor', 'session-idle', 'session-agent'],
    byId: {
      'session-rich': { id: 'session-rich', title: '解析迷雾之路', running: true },
      'session-poor': { id: 'session-poor', title: '阅读会话记录', running: true },
      'session-idle': { id: 'session-idle', title: '已结束的会话', running: false },
      'session-fresh': { id: 'session-fresh', title: '阅读所有文档', running: true },
      'session-agent': { id: 'session-agent', title: '你是一名游戏设计顾问', running: true },
    },
  })
const running = footer.component({ wide: true, useSessions })
assert.equal(running.props.className, 'am-running')
assert.equal(running.children.length, 3, 'one row per running session, idle and subagent sessions skipped')
const rows = running.children.map((node) => text(node))
assert.equal(rows[0], '解析迷雾之路本轮 1 min/¥3累计 1H05M/¥6', 'name first, then time, then whole yuan')
assert.equal(rows[1], '阅读会话记录本轮 0 min/¥1累计 0 min/¥1')
assert.match(rows[2], /^阅读所有文档本轮 0 min\/¥0累计 0 min\/¥0$/, 'an open turn counts up live')
assert.equal(running.children[0].children[1].props.title, '解析迷雾之路', 'the name is back in the row')
assert.match(running.props.title, /运行中会话已消耗/)
assert.equal(footer.component({ wide: true, useSessions: undefined }), null, 'no hook, no summary')

console.log('client smoke test ok:', {
  effects,
  seats: registrations.map((entry) => entry.options.id ?? entry.options.name),
  balance: text(chipTree),
  row: text(rich),
  detail: text(detail),
  running: text(running),
})
