import { z } from 'zod';

/**
 * High-Frequency Odds Movement Calculator
 * ----------------------------------------
 * Tracks real-time odds tick data across multiple bookmakers for the same
 * event/market, computes drift speed, volatility (rolling std-dev of log-odds
 * returns), momentum, sharp-vs-public signals and mean-reversion probability.
 *
 * Use-cases in PubBet:
 *  - Live-trading engine dashboard (drop steam moves / CLV)
 *  - Trigger for suspending markets on extreme volatility
 *  - Feed for the ML pricing model
 *  - Anti-abuse: detect latency-arb / cooldown anomalies
 */

// ---------- Schemas ----------

const TickSchema = z.object({
  /** Unix epoch milliseconds */
  ts: z.number().int().positive(),
  /** Decimal odds for back side (home) */
  back: z.number().positive(),
  /** Decimal odds for lay side (away / opposite) */
  lay: z.number().positive(),
  /** Bookmaker identifier */
  book: z.string().min(1),
  /** Optional traded volume in the last window (currency) */
  volume: z.number().nonnegative().optional(),
});

const InputSchema = z.object({
  eventId: z.string().min(1),
  market: z.enum(['h2h', 'spreads', 'totals', 'asian-handicap']),
  selection: z.enum(['home', 'away', 'over', 'under']),
  /** Tick stream sorted ascending by ts (per book or aggregated) */
  ticks: z.array(TickSchema).min(5),
  /** Optional rolling window in seconds (default 60s) */
  windowSec: z.number().int().positive().max(3600).default(60),
  /** Soft limit to flag an "extreme drift" event */
  volatilityThreshold: z.number().positive().default(0.05),
});

export type OddsTick = z.infer<typeof TickSchema>;
export type MovementInput = z.infer<typeof InputSchema>;

export interface MovementReport {
  eventId: string;
  market: string;
  selection: string;
  samples: number;
  windowSec: number;
  /** First and last mid prices in the window */
  firstMid: number;
  lastMid: number;
  /** Absolute and percentage drift */
  driftAbs: number;
  driftPct: number;
  /** Realised volatility (std-dev of log-odds returns) */
  volatility: number;
  /** Annualised volatility assuming 1 tick / second baseline */
  annualisedVol: number;
  /** Momentum in [-1, 1] (positive = odds shortening / steam) */
  momentum: number;
  /** Mean-reversion probability from Ornstein-Uhlenbeck test */
  meanReversionProb: number;
  /** Sharpe-like risk-adjusted drift */
  sharpeDrift: number;
  /** Signal classification */
  signal: 'STEAM' | 'DRIFT' | 'STABLE' | 'REVERSAL' | 'EXTREME_VOL';
  /** Number of distinct bookmakers contributing to the stream */
  booksActive: number;
  /** Aggregate traded volume (if provided) */
  totalVolume: number;
  /** ISO timestamp of generation */
  generatedAt: string;
}

// ---------- Pure math helpers ----------

const mid = (t: OddsTick): number => (t.back + t.lay) / 2;
const logReturn = (a: number, b: number): number => Math.log(b / a);

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Discretised Ornstein-Uhlenbeck mean-reversion estimator.
 *   dX = theta*(mu - X)*dt + sigma*dW
 * Returns a coarse mean-reversion probability in [0,1] by comparing
 * the observed half-life to a heuristic threshold (60s baseline).
 */
function ouMeanReversionProb(series: number[]): number {
  if (series.length < 10) return 0.5;
  // Estimate theta via OLS regression of dX on (mu - X)
  const mu = mean(series);
  let num = 0;
  let den = 0;
  for (let i = 1; i < series.length; i++) {
    const dx = series[i] - series[i - 1];
    const x = mu - series[i - 1];
    num += x * dx;
    den += x * x;
  }
  const theta = den === 0 ? 0 : num / den;
  if (theta <= 0) return 0.05; // trending — not mean reverting
  const halfLife = Math.log(2) / theta;
  // Heavier weight when half-life < 30s, lighter when > 5min
  if (halfLife <= 30) return 0.95;
  if (halfLife <= 120) return 0.75;
  if (halfLife <= 300) return 0.55;
  return 0.25;
}

// ---------- Use-case ----------

export class CalculateOddsMovement {
  /**
   * Execute the calculation over a tick stream.
   * Throws ZodError on invalid input.
   */
  execute(rawInput: unknown): MovementReport {
    const input = InputSchema.parse(rawInput);
    const { ticks, windowSec } = input;

    // Trim to window (most recent N seconds from latest tick)
    const lastTs = ticks[ticks.length - 1].ts;
    const cutoff = lastTs - windowSec * 1000;
    const window = ticks.filter((t) => t.ts >= cutoff);
    if (window.length < 5) {
      throw new Error('insufficient_ticks_in_window');
    }

    // Build mid-price series
    const mids = window.map(mid);
    const returns: number[] = [];
    for (let i = 1; i < mids.length; i++) {
      returns.push(logReturn(mids[i - 1], mids[i]));
    }

    const firstMid = mids[0];
    const lastMid = mids[mids.length - 1];
    const driftAbs = lastMid - firstMid;
    const driftPct = (driftAbs / firstMid) * 100;

    const volatility = stdDev(returns);
    const annualisedVol = volatility * Math.sqrt(365 * 24 * 3600);

    // Momentum = sign-aware normalised net drift over last 20% of window
    const tailLen = Math.max(2, Math.floor(mids.length * 0.2));
    const tail = mids.slice(-tailLen);
    const tailDrift = (tail[tail.length - 1] - tail[0]) / tail[0];
    const momentum = Math.max(-1, Math.min(1, tailDrift / Math.max(volatility, 1e-6)));

    const meanReversionProb = ouMeanReversionProb(mids);
    const sharpeDrift = volatility === 0 ? 0 : driftPct / (volatility * 100);

    const booksActive = new Set(window.map((w) => w.book)).size;
    const totalVolume = window.reduce((acc, w) => acc + (w.volume ?? 0), 0);

    let signal: MovementReport['signal'] = 'STABLE';
    if (volatility >= input.volatilityThreshold * 2) {
      signal = 'EXTREME_VOL';
    } else if (driftPct <= -2 && momentum < -0.5) {
      signal = 'STEAM';
    } else if (driftPct >= 2 && momentum > 0.5) {
      signal = 'DRIFT';
    } else if (meanReversionProb >= 0.7 && Math.abs(driftPct) >= 1) {
      signal = 'REVERSAL';
    }

    return {
      eventId: input.eventId,
      market: input.market,
      selection: input.selection,
      samples: window.length,
      windowSec,
      firstMid: round(firstMid, 4),
      lastMid: round(lastMid, 4),
      driftAbs: round(driftAbs, 4),
      driftPct: round(driftPct, 4),
      volatility: round(volatility, 6),
      annualisedVol: round(annualisedVol, 4),
      momentum: round(momentum, 4),
      meanReversionProb: round(meanReversionProb, 4),
      sharpeDrift: round(sharpeDrift, 4),
      signal,
      booksActive,
      totalVolume: round(totalVolume, 2),
      generatedAt: new Date().toISOString(),
    };
  }
}

function round(v: number, d: number): number {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

export default new CalculateOddsMovement();
