import { EventOdds, BookmakerOdds, ArbitrageOpportunity } from './types';

/**
 * Arbitrage Opportunity Scanner
 *
 * Detects guaranteed-profit scenarios across multiple bookmakers when the
 * combined implied probabilities of all outcomes are < 1.0 (a "surebet").
 *
 * Used by PubBet High-Frequency Odds pipeline to surface value bets in real
 * time. Profits are derived from divergent odds providers and are typically
 * short-lived (< 30s) so execution must be low-latency.
 */

interface ScannerConfig {
  minProfitMarginPct: number; // e.g. 1.5 => only flag if profit >= 1.5%
  maxStakeTotal: number;      // cap total wagered to manage exposure
  enabledBookmakers: string[]; // whitelist of bookmakers to consider
  minOdds: number;            // safety: ignore degenerate odds
  maxOdds: number;            // safety: ignore suspicious outliers
}

const DEFAULT_CONFIG: ScannerConfig = {
  minProfitMarginPct: 1.5,
  maxStakeTotal: 10000,
  enabledBookmakers: [],
  minOdds: 1.05,
  maxOdds: 1000,
};

/** Convert decimal odds to implied probability. */
export function oddsToImpliedProb(odds: number): number {
  if (odds <= 1) return 1;
  return 1 / odds;
}

/** Compute the Kelly-recommended stake fraction for an arbitrage leg. */
function recommendedStake(
  odds: number,
  totalStake: number,
  invProb: number,
): number {
  return totalStake * (odds * invProb) / totalStake * odds * invProb;
}

/**
 * Scan a single event (e.g. a match with home/draw/away outcomes) and return
 * any arbitrage opportunities.
 */
export function scanEvent(
  event: EventOdds,
  config: ScannerConfig = DEFAULT_CONFIG,
): ArbitrageOpportunity[] {
  const { outcomes } = event;
  if (!outcomes || outcomes.length < 2) return [];

  // For each outcome, keep the BEST (highest) odds across whitelisted books.
  type Best = { bookmakerId: string; odds: number; outcome: string };
  const bestPerOutcome: Record<string, Best> = {};

  for (const outcome of outcomes) {
    let best: Best | null = null;
    for (const book of outcome.bookmakers) {
      if (
        config.enabledBookmakers.length > 0 &&
        !config.enabledBookmakers.includes(book.bookmakerId)
      ) {
        continue;
      }
      if (book.odds < config.minOdds || book.odds > config.maxOdds) continue;
      if (!best || book.odds > best.odds) {
        best = { bookmakerId: book.bookmakerId, odds: book.odds, outcome: outcome.name };
      }
    }
    if (best) bestPerOutcome[outcome.name] = best;
  }

  const bests = Object.values(bestPerOutcome);
  if (bests.length < 2) return [];

  const sumImplied = bests.reduce((s, b) => s + oddsToImpliedProb(b.odds), 0);
  if (sumImplied >= 1) return []; // no arb

  const marginPct = (1 / sumImplied - 1) * 100;
  if (marginPct < config.minProfitMarginPct) return [];

  const stakes = bests.map((b) => ({
    outcome: b.outcome,
    bookmakerId: b.bookmakerId,
    odds: b.odds,
    stake: Number(((config.maxStakeTotal / sumImplied) * oddsToImpliedProb(b.odds)).toFixed(2)),
    payout: Number(((config.maxStakeTotal / sumImplied) * b.odds).toFixed(2)),
  }));

  const totalReturn = stakes[0].payout; // identical across legs by construction
  const profit = Number((totalReturn - config.maxStakeTotal).toFixed(2));

  return [
    {
      eventId: event.eventId,
      sport: event.sport,
      commenceTime: event.commenceTime,
      profitMarginPct: Number(marginPct.toFixed(3)),
      recommendedStakeTotal: config.maxStakeTotal,
      guaranteedProfit: profit,
      legs: stakes,
      detectedAt: new Date().toISOString(),
      expiresInMs: 30000,
    },
  ];
}

/** Batch scan across many events. */
export function scanMarket(
  events: EventOdds[],
  config: ScannerConfig = DEFAULT_CONFIG,
): ArbitrageOpportunity[] {
  const found: ArbitrageOpportunity[] = [];
  for (const ev of events) {
    found.push(...scanEvent(ev, config));
  }
  // Highest margin first.
  found.sort((a, b) => b.profitMarginPct - a.profitMarginPct);
  return found;
}

/**
 * Lightweight in-memory runner — drop-in for the HFO pipeline. Designed to
 * consume the live odds feed already produced by calculateLiveOdds.
 */
export class ArbitrageScanner {
  private config: ScannerConfig;

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  configure(partial: Partial<ScannerConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  ingest(events: EventOdds[]): ArbitrageOpportunity[] {
    return scanMarket(events, this.config);
  }
}

// Re-export supporting types so consumers have a single import.
export type { EventOdds, BookmakerOdds, ArbitrageOpportunity };
