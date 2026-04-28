# Changelog

All changes to this repository are documented here. Any agent or contributor modifying this repo must add an entry below describing what was changed and why.

---

## [2026-04-28] — Claude Sonnet 4.6

### Fix: Profit calculation charged cost on units sold instead of units ordered (`server.js:165`)
**What:** Changed `const totalCost = qtySold * cost` to `const totalCost = ordered * cost`.  
**Why:** Inventory cost is incurred at the time of ordering, not at the time of selling. The original formula never penalized over-ordering, eliminating the core tension of the newsvendor problem. Players could order 9999 units with zero downside.

### Fix: HUD profit desyncs from leaderboard after player reconnect (`public/index.html:1770`)
**What:** Replaced `state.myProfit += me.profit` with `state.myProfit = meInLb.totalProfit`, reading directly from the server-sent leaderboard payload.  
**Why:** The client was accumulating profit in a local variable. On disconnect/reconnect the variable resets to 0, causing the "My Profit" HUD to show a lower number than the leaderboard (which is server-driven and always correct). Syncing to the server value eliminates the desync.

### Fix: `optimalQ` for `random` distribution used an arbitrary formula (`server.js:207`)
**What:** Replaced the ad-hoc formula `mean + (mean * 0.6) * (criticalRatio * 2 - 1)` with a Monte Carlo simulation that samples 500 demand draws per candidate order quantity and picks the Q with the highest expected profit.  
**Why:** The `random` distribution is a 50/50 hybrid of Poisson and a uniform spike — there is no closed-form optimal Q for this mixture. The previous formula was a guess that did not follow from the newsvendor model, so the "Optimal Q" shown to players after each round was meaningfully wrong.
