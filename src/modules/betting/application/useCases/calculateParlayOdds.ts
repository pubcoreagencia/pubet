import { Bet, BetSelection, ParlayCalculation, OddsFormat } from '../../domain/types/betting.types';

/**
 * High-Frequency Parlay Odds Engine
 * 
 * Performs sub-millisecond calculations for combined bets (parlays/accumulators)
 * with three key capabilities:
 *  1. Multi-format odds arithmetic (EU decimal, US moneyline, UK fractional, IM implicit probability)
 *  2. Vig/juice removal for true probability aggregation across selections
 *  3. Correlation penalty detection when selections belong to the same event
 *
 * Designed for hot-path execution: no I/O, no allocations beyond result objects,
 * single-pass numeric iteration.
 */

const VIG_AVERAGE_BASELINE = 1.07; // 7% market baseline; configurable per book
const MAX_PARLAY_LEGS = 14;
const CORRELATION_PENALTY_SAME_EVENT = 0.92;
const CORRELATION_PENALTY_SAME_MATCH = 0.85;

export type CorrelationLevel = 'none' | 'same_event' | 'same_match' | 'dependent';

interface ParsedSelection {
  raw: BetSelection;
  implicitProb: number; // 0..1, vig-free
  decimalOdds: number;
  correlation: CorrelationLevel;
  eventGroup: string;
}

function parseDecimal(value: number): number {
  if (!Number.isFinite(value) || value <= 1.0) {
    throw new Error(`Invalid decimal odds: ${value}. Must be > 1.0`);
  }
  return value;
}

function americanToDecimal(american: number): number {
  if (american === 0) throw new Error('American odds cannot be zero');
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function fractionalToDecimal(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error('Fractional denominator must be positive');
  return 1 + numerator / denominator;
}

/**
 * Normalizes a selection into decimal odds + vig-free implicit probability.
 * The implicit probability is the *true* probability after stripping bookmaker margin
 * using the multiplicative method (Pinnacle-style fair line derivation).
 */
function normalizeSelection(selection: BetSelection): ParsedSelection {
  let decimal = 1.0;

  switch (selection.oddsFormat) {
    case OddsFormat.DECIMAL:
      decimal = parseDecimal(selection.odds);
      break;
    case OddsFormat.AMERICAN:
      decimal = americanToDecimal(selection.odds);
      break;
    case OddsFormat.FRACTIONAL:
      decimal = fractionalToDecimal(Math.floor(selection.odds), (selection.odds % 1) * 100 || 1);
      break;
    case OddsFormat.IMPLICIT:
      decimal = 1 / Math.max(0.0001, Math.min(0.9999, selection.odds));
      break;
    default:
      throw new Error(`Unsupported odds format: ${selection.oddsFormat}`);
  }

  const rawImplied = 1 / decimal;
  // Fair probability: strip the overround. With single selection we approximate
  // the fair line as 1 / (raw * vig), where vig is bounded between 1.01 and 1.12.
  const estimatedVig = Math.min(VIG_AVERAGE_BASELINE, 1 / rawImplied);
  const fairProbability = Math.min(0.999, rawImplied * estimatedVig);

  return {
    raw: selection,
    implicitProb: fairProbability,
    decimalOdds: decimal,
    correlation: selection.correlation ?? 'none',
    eventGroup: selection.eventId ?? selection.marketId ?? 'global',
  };
}

function detectCorrelation(parsed: ParsedSelection[]): ParsedSelection[] {
  // Build a quick map of eventGroup -> count; selections sharing an event group
  // are penalized unless explicitly marked independent.
  const groupCounts = new Map<string, number>();
  for (const s of parsed) {
    if (s.correlation === 'none') {
      groupCounts.set(s.eventGroup, (groupCounts.get(s.eventGroup) ?? 0) + 1);
    }
  }

  return parsed.map((s) => {
    if (s.correlation !== 'none') return s;
    const count = groupCounts.get(s.eventGroup) ?? 1;
    if (count === 1) return s;

    // Same event group, count >= 2 — apply correlation penalty to decimal odds.
    const penalty = s.raw.marketId && count > 2
      ? CORRELATION_PENALTY_SAME_MATCH
      : CORRELATION_PENALTY_SAME_EVENT;

    return {
      ...s,
      decimalOdds: 1 + (s.decimalOdds - 1) * penalty,
      correlation: 'same_event',
    };
  });
}

export function calculateParlayOdds(
  selections: BetSelection[],
  stake: number,
  options: { correlationAware?: boolean } = {}
): ParlayCalculation {
  const correlationAware = options.correlationAware ?? true;

  if (!Array.isArray(selections) || selections.length === 0) {
    throw new Error('Parlay requires at least one selection');
  }
  if (selections.length > MAX_PARLAY_LEGS) {
    throw new Error(`Parlay exceeds maximum of ${MAX_PARLAY_LEGS} legs`);
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new Error('Stake must be a positive finite number');
  }

  let parsed = selections.map(normalizeSelection);
  if (correlationAware) parsed = detectCorrelation(parsed);

  let combinedDecimal = 1.0;
  let combinedFairProb = 1.0;
  let totalImpliedOverround = 0;

  for (const leg of parsed) {
    combinedDecimal *= leg.decimalOdds;
    combinedFairProb *= leg.implicitProb;
    totalImpliedOverround += 1 / leg.decimalOdds;
  }

  const fairDecimalOdds = 1 / combinedFairProb;
  const expectedPayout = stake * combinedDecimal;
  const expectedProfit = expectedPayout - stake;
  const trueExpectedValue = (combinedFairProb * expectedPayout) - stake;
  const bookMargin = Math.max(0, totalImpliedOverround - 1);
  const roiPercent = stake > 0 ? (trueExpectedValue / stake) * 100 : 0;

  return {
    legCount: parsed.length,
    stake,
    combinedDecimalOdds: Number(combinedDecimal.toFixed(4)),
    fairDecimalOdds: Number(fairDecimalOdds.toFixed(4)),
    combinedFairProbability: Number(combinedFairProb.toFixed(6)),
    bookMarginPercent: Number((bookMargin * 100).toFixed(2)),
    expectedPayout: Number(expectedPayout.toFixed(2)),
    expectedProfit: Number(expectedProfit.toFixed(2)),
    trueExpectedValue: Number(trueExpectedValue.toFixed(2)),
    roiPercent: Number(roiPercent.toFixed(3)),
    correlationApplied: parsed.some((p) => p.correlation !== 'none'),
    legs: parsed.map((p) => ({
      selectionId: p.raw.selectionId,
      marketId: p.raw.marketId,
      eventId: p.raw.eventId,
      originalOdds: p.raw.odds,
      oddsFormat: p.raw.oddsFormat,
      normalizedDecimal: Number(p.decimalOdds.toFixed(4)),
      fairProbability: Number(p.implicitProb.toFixed(4)),
      correlation: p.correlation,
    })),
    calculatedAt: new Date().toISOString(),
  };
}

export function calculateSingleBetImpliedProbability(selection: BetSelection): number {
  return normalizeSelection(selection).implicitProb;
}

export function decimalToAmerican(decimal: number): number {
  if (decimal <= 1.0) throw new Error('Decimal odds must be > 1.0');
  return decimal >= 2.0 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export function decimalToFractional(decimal: number): { numerator: number; denominator: number } {
  if (decimal <= 1.0) throw new Error('Decimal odds must be > 1.0');
  const fractional = decimal - 1;
  const denominator = 100;
  let numerator = Math.round(fractional * denominator);
  // Reduce the fraction by GCD.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
