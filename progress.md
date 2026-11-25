# Pump.fun Sharpe Sprint — progress

Bounty: `u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532` ($2, 1st $1).
Deadline: 29 Nov 2026 00:00 WIB. Field: 8 submissions at detection.
Task: paper-trading bot (main.ts, Node 22), 6h pump.fun replay, ranked by
HOURLY SHARPE, net PnL must be > 0 to take a prize. Guardrails: max 5 open
positions, round trips >= 0.01 SOL on >= 20 distinct mints, max DD 50%.

## Method (honest, numbers first)

Kit downloaded fresh 26 Nov 00:21 WIB; RULES.txt checked — bundle
(transcripts_required), NOT strict-transcript, no sealed recording needed.
`makefun init` FIRST in the empty repo (root commit = .makefun only, anchor
drand round 34274844, hash d5d5f2e74467cba7ca947ea922f186511837c473).

The dev dataset is 24h of pump.fun events (2-3 Nov 2026, 128,058 events,
1,222 coins in the sampled universe). I backtested ~40 strategy variants in
the kit's own simulator port (tools/sim2.ts, hourly-equity Sharpe added),
on the dev half (part-00000, ~11h), the validation half (parts 1-2, ~13h),
the full 24h, and four 6h slices (the closest preview of the final window).
Full variant table in drafts.md.

## Key findings (all verified, not assumed)

1. The market is negative-sum after fees (1.25% curve fees + 105k lamports
   tx/order). Buying every launch, buying dips, momentum and "buy proven
   coins and hold" ALL lose on both halves.
2. EDA trap found and corrected: buying coins after real SOL crossed 20
   looked +26..+45% per trade — but 28 of the 163 coins were INSTANT
   COMPLETERS (create -> 85 SOL in ONE slot, 7 buys), which no bot can trade
   (2-slot latency, fill lands after completion). Excluding them, the pattern
   is -5%..-30% per trade. The EDA numbers in the first draft were wrong;
   the simulator is the ground truth.
3. The only near-breakeven pattern: launch sniper — buy in a coin's first
   3 slots, exit within 5 slots (TP +15% / SL -12%). Longer holds bleed;
   "let winners ride" (partial TP + trailing stop) is worse on every test.
4. Best filter: exactly 3 distinct non-creator buyers + creator committed
   >= 0.05 SOL (and <= 2.5 SOL) + creator not sold + real SOL 0.3-30.
   (minDevBuy 0.02/0.05/0.1 are identical on both halves — the filter is a
   cliff at ~0.02 SOL, not a knife-edge.)
5. A completion kicker (buy at 50 real SOL, hold 2000 slots, -20% stop) was
   tested and TURNED OFF: -0.32 SOL on dev, +0.01 SOL on validation.
6. Safety net (NEW): the strict filter yields only 11-17 coins in some 6h
   windows — below the 20-coin guardrail. The net relaxes the filter late
   in the window (level 1 at 3h: drop the dev-buy floor; level 2 at 4.5h:
   also accept 2-3 buyers) when the coin rate projects < 25 over 6h.
   Cost measured on 6h slices: -0.00..-0.03 SOL per window. All 4 slices
   pass the guardrail with the net on (21-27 coins) vs 3 of 4 failing
   without it (11-17 coins).

## Final entry (repo/strategy.ts, DEFAULT_PARAMS)

- Sniper lane: age <= 3 slots, stake 0.10 SOL (capped at 1% of real SOL),
  TP +15%, SL -12%, maxHold 5 slots, exit on creator sell.
  Filter: exactly 3 distinct buyers, devBuy 0.05-2.5 SOL, no dev sell,
  real SOL 0.3-30.
- Kicker lane: OFF (kickerRqLamports 0).
- Safety net: ON (level 1 at 3h, level 2 at 4.5h, project < 25 coins/6h).
- No pacing / order splitting (min_fills is 0; splitting only burns fees).
- No environment access / eval / dynamic import. Deterministic (verified: two
  identical sim runs). Smoke-tested through runBot stdin/stdout (buy order
  0.04 SOL emitted, exit 0).

## Backtest numbers (final config, safety net ON)

| window | net PnL | coins | trips | wins | max DD | Sharpe/hr |
|---|---|---|---|---|---|---|
| dev part-0 (~11h) | +0.018 SOL* | 30 | 30 | 8 | 0.3% | +0.289 |
| validation parts 1-2 (~13h) | -0.081 SOL | 43 | 43 | 7 | 1.1% | -0.525 |
| full 24h | -0.080 SOL | 99 | 99 | - | 1.2% | -0.303 |
| 6h slice 0 (03:09-09:09 UTC) | +0.014 SOL | 21 | 21 | 6 | 0.2% | +0.213 |
| 6h slice 1 (09:09-15:09 UTC) | -0.014 SOL | 25 | 25 | 6 | 0.5% | -0.053 |
| 6h slice 2 (15:09-21:09 UTC) | -0.071 SOL | 27 | 27 | 5 | 0.7% | -0.317 |
| 6h slice 3 (21:09-03:09 UTC) | -0.036 SOL | 21 | 21 | 2 | 0.4% | -0.247 |

*dev part-0 net is for the strict filter (net off); with the net on the
full-24h number is -0.080 SOL. The strict filter alone is +0.018 on dev
but -0.081 on validation — the +0.018 is noise, not an edge.

## HONEST FLAG (read this before submitting)

No variant tested is PnL-positive on BOTH halves of the dev data. The
final entry is the least-negative, most consistent combination found
(combined 24h -0.08 SOL, DD ~1%, Sharpe -0.30) — not a proven edge. On a
fresh 6h window it lands positive roughly 1 time in 4 (1 of 4 slices),
with Sharpe +0.21 in the best slice. The dev leaderboard currently shows
two entries at +0.27..+0.30 SOL / Sharpe +0.20..+0.22 (140-196 coins) —
those are ahead of every variant I could reproduce in the kit simulator;
their edge, if real, is not one I found. This entry is submitted as the
best free shot available, flagged as above. Do NOT present it to the user
as a likely winner.

## Execution-risk flags: 0

No security notice fired on any kit/git/gh output in this session.

## Files

- repo/main.ts, repo/strategy.ts, repo/vendor/agentfun-bot.ts (kit SDK, vendored)
- tools/: eda.py, eda2.py, eda3.py, eda4.py, sim2.ts, run_repo.ts,
  sweep_sniper.ts, run_slices.ts, debug_compare.ts, debug2.ts, smoke.ts
  (offline analysis only, NOT part of the entry)
- progress.md (this file), drafts.md (variant tournament record)
