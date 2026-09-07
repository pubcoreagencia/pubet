import { BetSelection } from '../types/BetSelection';

/**
 * Kelly Criterion stake calculator for optimal bet sizing.
 *
 * The Kelly Criterion determines the theoretically optimal size of a series
 * of bets to maximize the long-term growth rate of wealth. It is widely used
 * in advantage gambling and professional sports trading.
 *
 * Formula: f* = (bp - q) / b
 *   where:
 *     b = decimal odds - 1 (net payout per unit staked)
 *     p = probability of winning (model probability, not implied)
 *     q = probability of losing (1 - p)
 *
 * Fractional Kelly (e.g., 0.25 or 0.5) is applied by default to reduce
 * variance and protect bankroll from model miscalibration.
 */

export interface KellyInput {
  selection: BetSelection;
  bankroll: number;
  modelProbability: number;
  fractionalKelly?: number; // 0 < value <= 1, defaults to 0.25 (1/4 Kelly)
  maxStakePercent?: number; // safety cap, defaults to 0.05 (5% of bankroll)
}

export interface KellyResult {
  fullKellyStake: number;
  fractionalKellyStake: number;
  cappedStake: number;
  edge: number;
  expectedValue: number;
  shouldBet: boolean;
  reason?: string;
  decimalOdds: number;
  impliedProbability: number;
  kellyFraction: number;
  bankrollPercentage: number;
}

const DEFAULT_FRACTIONAL = 0.25;
const DEFAULT_MAX_STAKE_PCT = 0.05;
const MIN_BANKROLL = 1;
const MIN_ODDS = 1.01;
const MIN_PROB = 0.001;
const MAX_PROB = 0.999;

export class InvalidKellyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKellyInputError';
  }
}

function validateInput(input: KellyInput): void {
  if (!input.selection) {
    throw new InvalidKellyInputError('selection is required');
  }
  if (!Number.isFinite(input.bankroll) || input.bankroll < MIN_BANKROLL) {
    throw new InvalidKellyInputError(
      `bankroll must be a finite number >= ${MIN_BANKROLL}`,
    );
  }
  if (
    !Number.isFinite(input.modelProbability) ||
    input.modelProbability < MIN_PROB ||
    input.modelProbability > MAX_PROB
  ) {
    throw new InvalidKellyInputError(
      `modelProbability must be in (${MIN_PROB}, ${MAX_PROB})`,
    );
  }
  const fraction = input.fractionalKelly ?? DEFAULT_FRACTIONAL;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new InvalidKellyInputError('fractionalKelly must be in (0, 1]');
  }
  const cap = input.maxStakePercent ?? DEFAULT_MAX_STAKE_PCT;
  if (!Number.isFinite(cap) || cap <= 0 || cap > 1) {
    throw new InvalidKellyInputError('maxStakePercent must be in (0, 1]');
  }
  if (!Number.isFinite(input.selection.decimalOdds) || input.selection.decimalOdds < MIN_ODDS) {
    throw new InvalidKellyInputError(`decimalOdds must be >= ${MIN_ODDS}`);
  }
}

function impliedProbabilityFromOdds(decimalOdds: number): number {
  return 1 / decimalOdds;
}

export function calculateKellyCriterion(input: KellyInput): KellyResult {
  validateInput(input);

  const { selection, bankroll, modelProbability } = input;
  const fraction = input.fractionalKelly ?? DEFAULT_FRACTIONAL;
  const maxStakePct = input.maxStakePercent ?? DEFAULT_MAX_STAKE_PCT;

  const decimalOdds = selection.decimalOdds;
  const b = decimalOdds - 1; // net payout per unit staked
  const p = modelProbability;
  const q = 1 - p;

  const impliedProbability = impliedProbabilityFromOdds(decimalOdds);
  const edge = p - impliedProbability; // positive => +EV
  const expectedValue = p * (decimalOdds - 1) - q;

  // Full Kelly fraction: f* = (bp - q) / b
  const kellyFraction = (b * p - q) / b;

  // Never bet when there is no edge or negative Kelly.
  if (edge <= 0 || kellyFraction <= 0) {
    return {
      fullKellyStake: 0,
      fractionalKellyStake: 0,
      cappedStake: 0,
      edge,
      expectedValue,
      shouldBet: false,
      reason:
        edge <= 0
          ? 'No positive edge: model probability does not exceed implied probability'
          : 'Kelly fraction is non-positive',
      decimalOdds,
      impliedProbability,
      kellyFraction: Math.max(0, kellyFraction),
      bankrollPercentage: 0,
    };
  }

  const fullKellyStake = kellyFraction * bankroll;
  const fractionalKellyStake = kellyFraction * fraction * bankroll;

  const capAmount = maxStakePct * bankroll;
  const cappedStake = Math.min(fractionalKellyStake, capAmount);

  // Round down to whole currency units (cents-safe rounding).
  const roundedStake = Math.floor(cappedStake * 100) / 100;

  // Enforce a minimum practical stake to avoid dust bets.
  const MIN_STAKE = 1;
  const finalStake = roundedStake >= MIN_STAKE ? roundedStake : 0;

  return {
    fullKellyStake: Math.round(fullKellyStake * 100) / 100,
    fractionalKellyStake: Math.round(fractionalKellyStake * 100) / 100,
    cappedStake: finalStake,
    edge: Math.round(edge * 10000) / 10000,
    expectedValue: Math.round(expectedValue * 10000) / 10000,
    shouldBet: finalStake > 0,
    reason:
      finalStake === 0
        ? 'Computed stake below minimum practical unit (dust bet suppressed)'
        : undefined,
    decimalOdds,
    impliedProbability: Math.round(impliedProbability * 10000) / 10000,
    kellyFraction: Math.round(kellyFraction * 10000) / 10000,
    bankrollPercentage:
      Math.round((finalStake / bankroll) * 10000) / 10000,
  };
}

/**
 * Convenience helper to size a portfolio of +EV selections.
 * Caps the *aggregate* stake exposure to a percentage of bankroll to
 * prevent over-betting on correlated or coincident events.
 */
export function calculatePortfolioKelly(
  inputs: KellyInput[],
  options: { aggregateCapPercent?: number } = {},
): KellyResult[] {
  const aggregateCap = options.aggregateCapPercent ?? 0.15;
  const results = inputs.map(calculateKellyCriterion);

  const totalSuggested = results.reduce(
    (sum, r) => sum + (r.shouldBet ? r.cappedStake : 0),
    0,
  );
  const bankroll = inputs[0]?.bankroll ?? 0;
  const capAmount = aggregateCap * bankroll;

  if (totalSuggested > capAmount && totalSuggested > 0) {
    const scale = capAmount / totalSuggested;
    return results.map((r) => ({
      ...r,
      cappedStake:
        r.shouldBet
          ? Math.floor(r.cappedStake * scale * 100) / 100
          : 0,
      bankrollPercentage:
        r.shouldBet
          ? Math.round((r.cappedStake * scale / bankroll) * 10000) / 10000
          : 0,
    }));
  }

  return results;
}
