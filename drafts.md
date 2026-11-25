# Strategy tournament — Pump.fun Sharpe Sprint

Objective bounty, so the "tournament" is a backtest comparison, not a
one-liner vote. Every variant ran in the kit simulator port (tools/sim2.ts)
on dev part-00000 (~11h) and validation parts 1-2 (~13h). Metric: net PnL
(SOL), hourly Sharpe (mean/std of hourly equity returns), coins, max DD.
Winner = least-negative combined PnL + best combined Sharpe + >= 20 coins
per 6h (guardrail) + small DD. All numbers are from the simulator, not EDA
estimates (the EDA overstated H2 by +55% until instant completers were
excluded — see progress.md).

## House pilots (baseline, from the kit)

| variant | dev net | dev Sharpe | val net | val Sharpe | coins dev/val | DD dev |
|---|---|---|---|---|---|---|
| momentum | -9.384 | — | — | — | 48 / — | 95.0% |
| reversion | -1.779 | — | — | — | 70 / — | 18.2% |
| sniper (default, pacing on) | -0.134 | -0.606 | -0.299 | -1.046 | 135 / 212 | 1.7% |
| sniper (no pacing) | -0.118 | -0.520 | -0.293 | -1.014 | 134 / 211 | 1.5% |

## Survivor (buy proven coins, hold) — REJECTED

| variant | dev net | val net | notes |
|---|---|---|---|
| rq20 hold1000 | -1.199 | -1.720 | 29/85 coins, DD 13-33% |
| rq20 tp50 hold600 | -0.052 | -2.672 | best survivor on dev, catastrophic on val |
| rq20 hold300 | -0.196 | -1.908 | |
| rq60 hold2000 stop20 | -0.337 | +0.066 | only positive config anywhere; 6/13 coins — fails guardrail |
| rq60 hold2000 stop30 | -0.375 | +0.135 | 6/13 coins — fails guardrail |
| rq50 hold3000 stop20 | -0.345 | +0.100 | 7/18 coins — fails guardrail |
| rq40 hold2000 stop20 | -0.829 | -0.228 | 18/28 coins |

## Sniper tuning (house pilot params, swept in my runner)

| variant | dev net | dev Sharpe | val net | val Sharpe | coins dev/val |
|---|---|---|---|---|---|
| minBuyers3 hold10 | -0.035 | -0.129 | -0.196 | -0.839 | 43 / 66 |
| minBuyers3 hold5 | -0.005 | +0.046 | -0.194 | -0.818 | 43 / 66 |
| minBuyers3 hold5 minDevBuy0.1 | +0.018 | +0.289 | -0.081 | -0.525 | 30 / 43 |
| minBuyers3 hold5 stake.05 | -0.001 | +0.081 | -0.154 | -0.924 | 43 / 66 |
| minBuyers3 hold5 maxBuyers5 | -0.023 | +0.001 | -0.403 | -1.884 | 99 / 154 |
| minBuyers2 hold5 | -0.040 | -0.176 | -0.226 | -0.515 | 86 / 113 |
| minTrades3 hold10 | -0.051 | -0.198 | -0.253 | -0.808 | 77 / 101 |
| minRealSol5 hold10 | -0.079 | -0.578 | -0.122 | -0.485 | 21 / 37 |
| maxBuyers off hold10 | -0.114 | -0.275 | -0.433 | -0.739 | 199 / 333 |
| tp1+20 ride trail hold1000 | -0.132 | -0.338 | — | — | 43 / — |
| adds1 tp15 hold50 | -0.291 | -0.683 | — | — | 134 / — |
| hold200/500/1000 tp15 sl12 | -0.19..-0.25 | -0.94..-1.03 | — | — | 134 / — |

## Final pick (my strategy.ts, written fresh from spec)

Sniper, exactly 3 buyers, devBuy 0.05-2.5 SOL, TP +15% / SL -12%,
hold 5 slots, kicker OFF, safety net ON:

| window | net | coins | Sharpe/hr | DD |
|---|---|---|---|---|
| dev part-0 (net off) | +0.018 | 30 | +0.289 | 0.3% |
| validation (net off) | -0.081 | 43 | -0.525 | 1.1% |
| full 24h (net on) | -0.080 | 99 | -0.303 | 1.2% |
| 6h slices (net on) | +0.014 / -0.014 / -0.071 / -0.036 | 21 / 25 / 27 / 21 | +0.21 / -0.05 / -0.32 / -0.25 | <=0.7% |

Why this won: best combined PnL among all variants that can plausibly
clear 20 coins in 6h (-0.08 SOL over 24h vs -0.20..-0.43 for the rest),
smallest drawdowns (0.3-1.2% vs up to 95%), and the safety net is the
only tested mechanism that keeps every 6h slice above the 20-coin bar
(21-27 coins; strict filter alone fails 3 of 4 slices with 11-17 coins).

Why it is still flagged: no variant is positive on both halves. The
+0.018 dev number is within noise (30 trades). The final window is a
fresh sample; expected outcome is a small loss with ~25% chance of
landing positive. The two dev-leaderboard leaders (+0.27..+0.30 SOL,
Sharpe +0.20..+0.22, 140-196 coins) could not be reproduced by any
variant tested here.
