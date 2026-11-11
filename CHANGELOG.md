# Changelog

## 1.0.0 — 2026-11-11

First public release, consolidating the private `account-meter` build.

- Balance chip beside the Harness mark (`sidebar.brand.name`, rendered by this package).
- Per-session spend beside the Session row's time (`sidebar.session.row.trailing`), hidden below a configurable threshold (default 2 CNY).
- Hover-card detail (`sidebar.session.row.hover`): exact amount, call count, turn amount, subagent share.
- Running-session list at the sidebar foot (`sidebar.footer.action`): name, turn/total time and money per session.
- Provider-aware pricing (`provider/model`, `model`, `provider/*`, `default`), with cache-hit, cache-miss, cache-write and output rates per 1M tokens.
- Subagent sessions merged into their nearest non-subagent ancestor; orphaned subagents are skipped.
- Cold session logs folded through `sessionQuery` and cached by persistence revision; live sessions folded incrementally from `snapshotEvents`.
- Read-only `GET /dsh-balance-spend/state` route polled while the page is visible; the client echoes its bundle version and stylesheet mode back so a stale page is detectable.
- Live estimate for the in-flight model call (`≈`): streamed deltas become output tokens, the prompt comes from `tokenMeter.measure()` and is priced with the previous call's cache-hit mix; the logged `usage` replaces it on commit, and the page polls every 5 s while a round is open.
