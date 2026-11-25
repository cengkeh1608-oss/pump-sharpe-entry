// Cleanest — a pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Design (from offline analysis of the kit's 24h dev dataset, 1,222 coins,
// and ~40 backtested variants in the local simulator):
//   * Buying every launch, buying dips, momentum and "buy proven coins and
//     hold" ALL lose after fees. The only near-breakeven pattern is the
//     launch sniper: buy in a coin's first 3 slots, exit within 5 slots
//     (TP +15% / SL -12%). Longer holds bleed; tight stops kill winners.
//   * The market is negative-sum after the 1.25% curve fees + tx fees, so
//     no variant is positive on BOTH halves of the dev data. The filters
//     below are the least-negative, most consistent combination found:
//     exactly 3 distinct non-creator buyers in the first slots (fewer =
//     dead, more = bundle dump in waiting), creator committed >= 0.05 SOL
//     and <= 2.5 SOL, creator not sold, real SOL 0.3-30. Dev: -0.005 SOL,
//     Sharpe/hr +0.05, DD 0.4%, 43 coins. Validation half: -0.19 SOL.
//     Honest flag: this is the best of a losing field, not a proven edge.
//   * A completion kicker (buy coins crossing 50 real SOL, hold up to 2000
//     slots, -20% stop) was tested and TURNED OFF: in this bot it contributed
//     -0.32 SOL on the dev half and +0.01 SOL on the validation half — high
//     variance, negative expectancy. The lane stays in the code with
//     kickerRqLamports 0 (off) so the tested-and-rejected idea is on the
//     record, not hidden.
//   * No pacing / order splitting: min_fills is 0, splitting only burns tx
//     fees. No clock, no randomness, no I/O, no environment access. Deterministic.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Sniper: youngest/oldest age (slots since create) at which a coin may be bought. */
  sniperMinAge: number;
  sniperMaxAge: number;
  /** Sniper: lamports per buy (each order still capped at 1% of real SOL). */
  sniperStakeLamports: number;
  /** Sniper: smallest single buy worth paying the tx fee for. */
  sniperMinBuyLamports: number;
  /** Sniper: real SOL reserve window at decision time (lamports). */
  sniperMinRealSol: number;
  sniperMaxRealSol: number;
  /** Sniper: creator's own buys in the create slot: lamports window. */
  sniperMinDevBuy: number;
  sniperMaxDevBuy: number;
  /** Sniper: distinct non-creator buyers before entry: exactly this many (min == max). */
  sniperBuyers: number;
  /** Sniper: skip the coin when the creator sold before entry. */
  sniperSkipDevSold: boolean;
  /** Sniper: exit when the position is worth this much over its cost (bps). */
  sniperTpBps: number;
  /** Sniper: exit when it is worth this much under its cost (bps). */
  sniperSlBps: number;
  /** Sniper: exit after holding this many slots. */
  sniperMaxHold: number;
  /** Sniper: exit when the creator sells while held. */
  sniperExitOnDevSell: boolean;
  /** Kicker: buy when a coin's real SOL first reaches this (lamports). 0 = lane off. */
  kickerRqLamports: number;
  /** Kicker: lamports per buy. */
  kickerStakeLamports: number;
  /** Kicker: exit after holding this many slots. */
  kickerMaxHold: number;
  /** Kicker: disaster stop, exit when value falls this far under cost (bps). */
  kickerStopBps: number;
  /** Kicker: how many of the 5 position slots this lane may use. */
  kickerMaxSlots: number;
  /** Safety net: when the coin rate projects to fewer than safetyProjectedMin coins over 6h, relax the sniper filter (level 1: drop the dev-buy floor; level 2: also accept 2-3 buyers). The 20-coin guardrail is worth more than a few low-quality trades. The net only starts relaxing late in the window so the strict filter does most of the work. */
  safetyNet: boolean;
  /** Projected 6h coin count below which the net relaxes the filter. */
  safetyProjectedMin: number;
  /** Elapsed seconds before level 1 may fire. */
  safetyLevel1After: number;
  /** Elapsed seconds before level 2 may fire. */
  safetyLevel2After: number;
}

export const DEFAULT_PARAMS: Params = {
  sniperMinAge: 0,
  sniperMaxAge: 3,
  sniperStakeLamports: 100_000_000,
  sniperMinBuyLamports: 5_000_000,
  sniperMinRealSol: 300_000_000,
  sniperMaxRealSol: 30_000_000_000,
  sniperMinDevBuy: 50_000_000,
  sniperMaxDevBuy: 2_500_000_000,
  sniperBuyers: 3,
  sniperSkipDevSold: true,
  sniperTpBps: 1500,
  sniperSlBps: 1200,
  sniperMaxHold: 5,
  sniperExitOnDevSell: true,
  kickerRqLamports: 0,
  kickerStakeLamports: 150_000_000,
  kickerMaxHold: 2000,
  kickerStopBps: 2000,
  kickerMaxSlots: 1,
  safetyNet: true,
  safetyProjectedMin: 25,
  safetyLevel1After: 10800,
  safetyLevel2After: 16200,
};

const FEE_BPS = 125n;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  trades: number;
  devSold: boolean;
  lastTradeSlot: number;
  /** Slot when real SOL first reached the kicker threshold (0 = not yet). */
  crossedSlot: number;
  /** Never buy it again (bought, exited, filtered out for good, or completed). */
  done: boolean;
  /** Sniper lane already passed on it (aged out or failed the filter). */
  sniperDone: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
  /** 'sniper' or 'kicker': which lane owns this position. */
  lane: 'sniper' | 'kicker';
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Mints whose kicker buy is in flight (filled later; the lane is fixed on fill). */
const pendingKicker = new Set<Pubkey>();

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const sniperStake = BigInt(P.sniperStakeLamports);
  const sniperMinBuy = BigInt(P.sniperMinBuyLamports);
  const kickerStake = BigInt(P.kickerStakeLamports);
  const kickerRq = BigInt(P.kickerRqLamports);
  /** Distinct mints with a filled buy (guardrail count). */
  const traded = new Set<Pubkey>();
  let firstTime = 0;
  let nowTime = 0;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          devBuy: 0n,
          buyers: new Set(),
          trades: 0,
          devSold: false,
          lastTradeSlot: e.slot,
          crossedSlot: 0,
          done: false,
          sniperDone: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          if (isDev && e.slot === c.createSlot) c.devBuy += BigInt(e.sol_amount);
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null || e.block_time === undefined) continue;
        if (firstTime === 0) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      // Safety net level: 0 = strict filter, 1 = drop the dev-buy floor,
      // 2 = also accept 2-3 distinct buyers. Decided from the coin rate so far.
      // Late triggers only: the strict filter does most of the work.
      let relax = 0;
      if (P.safetyNet && firstTime > 0) {
        const elapsed = nowTime - firstTime;
        const elapsedHours = elapsed / 3600;
        const projected6h = (traded.size / Math.max(elapsedHours, 0.25)) * 6;
        if (elapsed >= P.safetyLevel1After && projected6h < P.safetyProjectedMin) relax = 1;
        if (elapsed >= P.safetyLevel2After && projected6h < 20) relax = 2;
      }
      const effMinDevBuy = relax >= 1 ? 0n : BigInt(P.sniperMinDevBuy);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') traded.add(f.mint);
        if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
          const lane: 'sniper' | 'kicker' = pendingKicker.has(f.mint) ? 'kicker' : 'sniper';
          pendingKicker.delete(f.mint);
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), devSoldAtOpen: coins.get(f.mint)?.devSold ?? false, lane });
        } else if (f.side === 'buy' && f.status !== 'rejected') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        }
        if (f.side === 'sell' && f.status === 'filled') {
          held.delete(f.mint);
          selling.delete(f.mint);
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false, lane: 'sniper' };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (h.lane === 'sniper') {
          if (basis > 0n) {
            if (value * BPS >= basis * (BPS + BigInt(P.sniperTpBps))) exit = true;
            if (value * BPS <= basis * (BPS - BigInt(P.sniperSlBps))) exit = true;
          }
          if (state.slot - h.openedSlot >= P.sniperMaxHold) exit = true;
          if (c !== undefined && P.sniperExitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        } else {
          if (basis > 0n && value * BPS <= basis * (BPS - BigInt(P.kickerStopBps))) exit = true;
          if (state.slot - h.openedSlot >= P.kickerMaxHold) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      let kickerOpen = pendingKicker.size;
      for (const h of held.values()) if (h.lane === 'kicker') kickerOpen += 1;
      // Kicker lane first (it needs a reserved slot; sniper trades are seconds-long).
      if (P.kickerRqLamports > 0 && kickerOpen < P.kickerMaxSlots) {
        for (const c of coins.values()) {
          if (orders.length >= cap) break;
          if (c.done || c.complete) continue;
          if (state.positions.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
          const curve = state.curves.get(c.mint);
          if (curve === undefined || curve.complete) continue;
          if (c.crossedSlot === 0) {
            if (curve.real_quote_reserves >= kickerRq) c.crossedSlot = state.slot;
            else continue;
          }
          if (state.slot - c.crossedSlot > 500) {
            c.done = true;
            continue;
          }
          if (open >= state.hello.caps.max_open_positions) break;
          const maxBuy = state.maxBuyLamports(c.mint);
          const amount = kickerStake < maxBuy ? kickerStake : maxBuy;
          if (amount < sniperMinBuy) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
          free -= amount + tx;
          c.done = true;
          open += 1;
          kickerOpen += 1;
          // Mark the lane: the fill handler fixes it from this set when the fill lands.
          pendingKicker.add(c.mint);
          break;
        }
      }
      // Sniper lane.
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.sniperDone) continue;
        const age = state.slot - c.createSlot;
        if (age > P.sniperMaxAge) {
          c.sniperDone = true;
          continue;
        }
        if (age < P.sniperMinAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (state.positions.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.sniperMinRealSol) || rq > BigInt(P.sniperMaxRealSol)) continue;
        if (c.devBuy < effMinDevBuy || c.devBuy > BigInt(P.sniperMaxDevBuy)) continue;
        const buyersOk = relax >= 2 ? c.buyers.size >= 2 && c.buyers.size <= 3 : c.buyers.size === P.sniperBuyers;
        if (!buyersOk) continue;
        if (c.devSold && P.sniperSkipDevSold) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = sniperStake < maxBuy ? sniperStake : maxBuy;
        if (amount < sniperMinBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
        free -= amount + tx;
        c.done = true;
        open += 1;
      }
      return orders;
    },
  };
}
