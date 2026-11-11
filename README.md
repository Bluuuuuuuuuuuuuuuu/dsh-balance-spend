# Balance & Spend

在 DeepSeek Harness 侧栏里直接看钱：左上角 Harness 图标旁是账户余额，每个会话行旁是该会话累计花了多少，侧栏底部列出正在运行的会话此刻的开销。

插件只读取数据，不向会话日志写入任何东西，也不接管任何原生控件（唯一的例外是品牌文字，见下文）。

## 显示的位置

| 位置 | 槽位 | 内容 |
| --- | --- | --- |
| 左上角品牌行 | `sidebar.brand.name` | 账户余额胶囊，例：`¥86.12` |
| 会话行，时间右侧 | `sidebar.session.row.trailing` | 该会话累计消耗，低于阈值不显示，例：`¥6.5` |
| 会话行悬停卡片 | `sidebar.session.row.hover` | 精确金额、调用次数、本轮金额、其中子代理 |
| 侧栏底部 | `sidebar.footer.action` | 每个正在运行的会话一行：名称 + `本轮 7 min/¥3` + `累计 31 min/¥21` |

几点设计上的取舍：

- 金额放在时间右侧而不是标题左侧：标题左侧那 16px 是宿主的状态圆点与定时任务时钟的地盘，两个图标挤在一起会互相遮挡。
- 会话行处于「运行中/未读完成」等非空闲状态时，那一格由宿主的旋转圆点占用，行内金额不会挂载，所以运行中的钱显示在底部列表里，并在那里同时给出本轮与累计用时。
- 悬停时宿主会临时隐藏行内图标（悬停卡片会接管），此时卡片里的数字就是同一个口径。
- 折叠成 56px 窄栏时只显示品牌图标，余额胶囊随品牌文字一起隐藏。
- 品牌文字槽位原本由官方包占着，本插件以更低优先级接管并自行绘制品牌文字；其余三个槽位都是新增条目，不改动任何已有控件。

## 安装

```bash
dsh plugin add dsh-balance-spend
```

或写进 Profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: balance-spend
      name: 'dsh-balance-spend'
      config:
        minCostToShow: 2
```

重启（或重新加载插件）后生效。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `minCostToShow` | `2` | 会话累计消耗低于此值时不显示金额，单位同 `currency` |
| `currency` | `CNY` | 余额显示优先使用的币种 |
| `refreshSeconds` | `30` | 客户端轮询间隔，最小 5 秒 |
| `balanceTtlSeconds` | `60` | 一次余额读数复用多久 |
| `coldSessionsPerPass` | `200` | 每次刷新最多折多少个尚未缓存的冷会话日志 |
| `pricing` | 见下 | 每 100 万 token 的价格，单位同 `currency` |

`pricing` 的键支持三种写法，按 `provider/model` → `model` → `provider/*` 的顺序匹配；都匹配不到时先用 `default`，再退到表里最贵的一档并在控制台告警（宁可高估，不要漏算）。内置默认为 DeepSeek 与 Anthropic 的牌价：

```yaml
pricing:
  deepseek-account/deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, cacheWrite: 2, output: 8 }
  deepseek-account/deepseek-v4-pro: { cacheHit: 0.15, cacheMiss: 4.5, cacheWrite: 4.5, output: 13.5 }
  claude/default: { cacheHit: 2.15, cacheMiss: 21.5, cacheWrite: 26.9, output: 107 }  # USD 牌价 × 7.15
```

## 金额是怎么算出来的

数据源是**会话日志**（`assistant/message` 事件里的 `usage`），不是账单：

```
cost = (inputTokens × cacheMiss + cacheReadTokens × cacheHit
        + cacheWriteTokens × cacheWrite + outputTokens × output) / 1,000,000
```

`inputTokens` 是不含缓存命中的输入量，`cacheReadTokens` / `cacheWriteTokens` 分开计，模型与厂商取自 `message.source`。一次 `assistant/message` 记一次模型调用。

- **累计**：该会话日志里所有调用的和。
- **本轮**：最近一个 `turn/start` 之后的调用之和；新一轮刚开始、第一次模型调用还没返回时，会补上一个带 `≈` 的**实时估算**（见下）。
- **实时估算**：正在流式输出的那次调用还没有 `usage`，插件订阅宿主的 `agent/assistant-stream`，用已经流出的文本按 token 估算输出量（中日韩字符约 1 token/字，拉丁文本约 4 字符/token），输入量取自 `tokenMeter.measure()`（宿主自己的上下文估算），输入按上一次调用的缓存命中比例定价。调用一落地，日志里的真实 `usage` 立刻覆盖估算，`≈` 随之消失。有会话处于运行中时，客户端轮询从 `refreshSeconds` 缩短到 5 秒。
- **子代理**：`origin: 'subagent'` 或 `delegationDepth > 0` 的会话不单独成行，金额并入最近的父会话，悬停卡片里给出「其中子代理」的份额。父会话不在快照里的孤儿子代理不会被认领，避免张冠李戴。
- **冷会话**：已结束的会话日志用 `sessionQuery` 读取，按持久化 revision 缓存，重启后分批补齐。

余额来自 `deepseekAccount.getBalance()`，把主钱包与赠送钱包按币种相加；读不到时保留上一次的值。

## 已知限制

- 价格是**牌价估算**，不是平台发票；折扣、赠送额度、缓存写入计费规则的差异都可能让数字与真实扣费不同。
- 从其他工具导入的会话（例如只有 user/assistant 文本、没有 `usage` 的转录）无法计价，显示为 ¥0。
- 一轮刚开始、或整个会话还没有过一次模型调用时，金额只能是 0——这是日志的事实，不是漏算；从流式输出开始，插件会给出带 `≈` 的实时估算。
- `≈` 金额是流式估算，不是账单：输出 token 由文本长度推算，输入量取自宿主的上下文估算，可能与真实扣费有偏差；调用落地后会立即换成真实值。
- 需要桌面版/网页版的侧栏与工作区包（`@deepseek-ai/dsh-client-ui-sidebar`、`-workspace`）；纯终端界面没有这些槽位。
- 行内金额在悬停、聚焦或菜单打开时会被宿主隐藏，这是槽位契约本身的行为。

## 隐私

- 唯一的对外请求是宿主调用平台接口取余额；金额计算全部在本地完成，不发送会话内容。
- 客户端只向同源的 `GET /dsh-balance-spend/state` 取一份只读快照（Cookie 认证，`cache-control: no-store`）。

## 开发

```bash
node test-host.mjs    # Host 半分：用假会话存储驱动真实折叠逻辑
node test-client.mjs  # Client 半分：在 vm 里加载 client.js，断言四个槽位与渲染文本
```

## English

**Balance & Spend** shows the account balance beside the Harness mark, the cost of every Session next to its row, and a sidebar-foot list of what the running sessions are burning right now.

- Balance chip in `sidebar.brand.name` (rendered by this package at a lower priority than the shipped wordmark).
- Per-session spend in `sidebar.session.row.trailing` — after the row's time, never in the 16px leading cell owned by the status dot and the scheduled-task clock — hidden below `minCostToShow` (default 2).
- Exact amount, call count, turn amount and subagent share in `sidebar.session.row.hover`.
- One line per running session in `sidebar.footer.action`: name, `Turn 7 min/¥3`, `Total 31 min/¥21`.

Costs are folded locally from each session log's `assistant/message` usage with the configurable `pricing` table (CNY per 1M tokens, keys `provider/model`, `model` or `provider/*`). Subagent sessions are merged into their nearest non-subagent ancestor. Nothing is written to the session log; the only network call is the host's balance request.

Prices are list-price estimates, not an invoice. Imported transcripts without `usage` cannot be priced and show ¥0. A brand-new turn shows 0 until its first model call starts streaming; from then on the plugin shows an `≈` live estimate (streamed tokens for output, `tokenMeter.measure()` for the prompt, priced with the previous call's cache-hit mix) and replaces it with the logged `usage` the moment the call lands. While any round is open the page polls every 5 s.

MIT licensed.
