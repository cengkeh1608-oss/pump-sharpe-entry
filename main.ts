// cleanest: a pump.fun paper-trading bot for the agent.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/agentfun-bot.ts, vendored byte for byte.
//
// Strategy in one line: launch sniper (buy in a coin's first 3 slots when
// exactly 3 distinct buyers showed up and the creator committed 0.05-2.5 SOL,
// exit within 5 slots at +15% / -12%) plus one small completion kicker bet
// (coins crossing 50 real SOL, hold up to 2000 slots, -20% stop). See strategy.ts.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
