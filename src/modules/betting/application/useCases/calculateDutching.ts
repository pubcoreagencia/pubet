/**
 * Dutching Calculator - PubBet iGaming Module
 * ------------------------------------------------
 * Distributes a total bankroll across multiple selections so that
 * the profit (or break-even) is identical regardless of which
 * selection actually wins.
 *
 * Used in horse racing, sports accumulators and live-market
 * arbitrage strategies where the bettor wants equalized returns.
 *
 * Author: High-Frequency Odds Architect (Setor 8)
 */

export interface DutchingSelection {
  /** Stable identifier (runner id, market id, etc.) */
  id: string;
  /** Decimal odds of the selection (e.g. 4.50) */
  odds: number;
}

export interface DutchingInput {
  /** Total amount the bettor is willing to risk */
  totalStake: number;
  /** Selections to dutch (minimum 2) */
  selections: DutchingSelection[];
  /** Commission taken by the bookmaker (0..1). Default 0 */
  commission?: number;
  /** Optional round-stake precision. Default 0.01 */
  roundingPrecision?: number;
}

export interface DutchingStake {
  id: string;
  odds: number;
  stake: number;
  potentialReturn: number;
  profitIfWins: number;
  percentageOfBankroll: number;
}

export interface DutchingResult {
  totalStake: number;
  totalReturn: number;
  profit: number;
  /** True when profit > 0 (super-dutch / value dutch) */
  isValueBet: boolean;
  /** True when profit === 0 (break-even dutch) */
  isBreakEven: boolean;
  /** Aggregated book percentage of the dutched selections */
  bookPercentage: number;
  stakes: DutchingStake[];
}

export class DutchingError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'DutchingError';
  }
}

const DEFAULT_PRECISION = 0.01;
const MIN_PRECISION = 0.01;

/**
 * Round a number down to the nearest stake increment
 * (floor ensures the bettor never exceeds the planned bankroll).
 */
function floorTo(value: number, precision: number): number {
  if (precision < MIN_PRECISION) precision = MIN_PRECISION;
  const factor = 1 / precision;
  return Math.floor(value * factor) / factor;
}

/**
 * Validate the Dutching input. Throws DutchingError on failure.
 */
export function validateDutchingInput(input: DutchingInput): void {
  if (!input || typeof input !== 'object') {
    throw new DutchingError('Invalid Dutching input payload', 'INVALID_INPUT');
  }

  const { totalStake, selections, commission = 0 } = input;

  if (typeof totalStake !== 'number' || !Number.isFinite(totalStake) || totalStake <= 0) {
    throw new DutchingError('totalStake must be a positive finite number', 'INVALID_TOTAL_STAKE');
  }

  if (!Array.isArray(selections) || selections.length < 2) {
    throw new DutchingError('At least two selections are required to dutch', 'INVALID_SELECTIONS');
  }

  if (commission < 0 || commission >= 1) {
    throw new DutchingError('commission must be in the range [0, 1)', 'INVALID_COMMISSION');
  }

  for (const sel of selections) {
    if (!sel.id || typeof sel.id !== 'string') {
      throw new DutchingError('Every selection requires a string id', 'INVALID_SELECTION_ID');
    }
    if (typeof sel.odds !== 'number' || !Number.isFinite(sel.odds) || sel.odds <= 1) {
      throw new DutchingError(
        `Invalid odds (${sel.odds}) for selection ${sel.id}. Decimal odds must be > 1`,
        'INVALID_ODDS',
      );
    }
  }
}

/**
 * Calculate the implied probability for a decimal odd.
  * probability = 1 / odds.
  */
export function impliedProbability(odds: number): number {
  return 1 / odds;
}

/**
 * Calculate the book percentage (overround) of the dutched set.
  * Returns a value in the 0..N range where > 1 indicates an
  * bookmaker margin, < 1 indicates a dutch value opportunity.
  */
export function calculateBookPercentage(selections: DutchingSelection[]): number {
  const sum = selections.reduce((acc, s) => acc + impliedProbability(s.odds), 0);
  return sum;
}

/**
 * Core Dutching algorithm.
  *
  * stake_i = totalStake * (1/odds_i) / sum(1/odds_j)
  *
  * With commission:
  *   effective_odds_i = odds_i * (1 - commission)
  *
  * The result is rounded down to `roundingPrecision` and the
  * unallocated cents are surfaced inside `profit` so the caller
  * can log the drift and adjust bankrolls if needed.
  */
export function calculateDutching(input: DutchingInput): DutchingResult {
  validateDutchingInput(input);

  const { totalStake, selections, commission = 0, roundingPrecision = DEFAULT_PRECISION } = input;

  const effectiveOdds = selections.map((s) => s.odds * (1 - commission));
  const inverseSum = effectiveOdds.reduce((acc, o) => acc + 1 / o, 0);

  const bookPercentage = calculateBookPercentage(selections);

  // Theoretical stake per selection (un-rounded)
  const theoretical = selections.map((s, idx) => ({
    id: s.id,
    odds: s.odds,
    effectiveOdd: effectiveOdds[idx],
    rawStake: (totalStake * (1 / effectiveOdds[idx])) / inverseSum,
  }));

  // Floor each stake to the configured precision
  const roundedStakes = theoretical.map((t) =>
    floorTo(t.rawStake, roundingPrecision),
  );

  const allocated = roundedStakes.reduce((a, b) => a + b, 0);
  const leftover = Number((totalStake - allocated).toFixed(6));

  const stakes: DutchingStake[] = theoretical.map((t, idx) => {
    const stake = roundedStakes[idx];
    const potentialReturn = Number((stake * t.odds).toFixed(2));
    const profitIfWins = Number((potentialReturn - totalStake).toFixed(2));
    const percentageOfBankroll = totalStake === 0 ? 0 : stake / totalStake;

    return {
      id: t.id,
      odds: t.odds,
      stake,
      potentialReturn,
      profitIfWins,
      percentageOfBankroll,
    };
  });

  // Reference profit (assuming all stakes were perfectly proportioned).
  // Equals (totalStake * (1 / bookPercentage)) - totalStake.
  const perfectReturn = totalStake / bookPercentage;
  const profit = Number((perfectReturn - totalStake).toFixed(2));

  const isValueBet = bookPercentage < 1;
  const isBreakEven = Math.abs(bookPercentage - 1) < 1e-6;

  return {
    totalStake,
    totalReturn: Number(perfectReturn.toFixed(2)),
    profit,
    isValueBet,
    isBreakEven,
    bookPercentage: Number(bookPercentage.toFixed(4)),
    stakes: stakes.map((s, idx) => ({
      ...s,
      // surface rounding drift as a small extra stake on the favorite (longest shot) only when leftover > 0
      stake: idx === 0 && leftover > 0 ? Number((s.stake + leftover).toFixed(2)) : s.stake,
    })),
  };
}

/**
 * Convenience helper: returns only the stake distribution as a
 * dictionary for quick persistence / broadcasting to the frontend.
 */
export function dutchStakeMap(input: DutchingInput): Record<string, number> {
  const result = calculateDutching(input);
  return result.stakes.reduce<Record<string, number>>((acc, s) => {
    acc[s.id] = s.stake;
    return acc;
  }, {});
}
