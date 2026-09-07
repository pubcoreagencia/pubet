import { EventOutcome, SelectionMarket, AsianHandicapLine, AsianHandicapSelection, Decimal } from '../../domain/types';

/**
 * Asian Handicap (AH) odds calculator.
 *
 * Supports full lines (-2, -1, 0, +1, +2...), half lines (-0.25, -0.5, -0.75...)
 * and quarter lines that are split into two adjacent half lines.
 *
 * The outcome is computed as the team's effective score (selection score + handicap)
 * versus the opposing team's raw score.
 *
 * Example:
 *   Home -1.75 @ 1.95, Away +1.75 @ 1.95
 *   Home scores 2, Away scores 1
 *   Home effective = 2 - 1.75 = 0.25  => push half-bet -> stake/2 returned
 *   Away effective = 1 + 1.75 = 2.75  => loss
 */

const QUARTER_STEP = 0.25;
const HALF_STEP = 0.5;

interface RawScore {
  home: number;
  away: number;
}

export interface AsianHandicapInput {
  selection: AsianHandicapSelection;
  market: SelectionMarket;
  /** Decimal odds offered by the book for this selection (e.g. 1.95). */
  decimalOdds: number;
  /** Final score (or live-trimmed score) of the event. */
  score: RawScore;
  /** Stake placed by the bettor. */
  stake: number;
}

export interface AsianHandicapResult {
  outcome: MatchEventOutcome;
  /** Final amount returned to the bettor including the original stake. */
  payout: number;
  /** Net profit (positive) or net loss (negative). */
  profit: number;
  /** Detailed breakdown for ledger / audit trail. */
  breakdown: AsianHandicapBreakdownLine[];
}

export interface AsianHandicapBreakdownLine {
  halfLine: number;
  outcome: MatchEventOutcome;
  payout: number;
}

export enum MatchEventOutcome {
  Win = 'WIN',
  HalfWin = 'HALF_WIN',
  Push = 'PUSH',
  HalfLoss = 'HALF_LOSS',
  Loss = 'LOSS',
}

export class AsianHandicapCalculator {
  /**
   * Splits a handicap line into half-line constituents.
   * - Whole lines (e.g. -1) -> single [-1]
   * - Half lines (e.g. -0.5) -> single [-0.5]
   * - Quarter lines (e.g. -0.75) -> [-0.5, -1] (split stake 50/50)
   */
  static splitToHalfLines(line: number): number[] {
    if (!Number.isFinite(line)) {
      throw new Error(`Invalid handicap line: ${line}`);
    }
    const remainder = Math.abs(line) % QUARTER_STEP;
    const sign = line < 0 ? -1 : 1;
    const abs = Math.abs(line);

    if (abs === 0) return [0];
    if (remainder === 0) {
      // Whole or half line already
      return [line];
    }
    if (Math.abs(remainder - HALF_STEP) < 1e-9) {
      // Quarter line -> split into two adjacent half lines
      const low = sign * (abs - QUARTER_STEP);
      const high = sign * (abs + QUARTER_STEP);
      return [low, high];
    }
    throw new Error(`Handicap line must be a multiple of 0.25: ${line}`);
  }

  /**
   * Resolves a single half-line given a raw score and a team perspective.
   */
  static resolveHalfLine(
    selection: AsianHandicapSelection,
    halfLine: number,
    score: RawScore,
  ): MatchEventOutcome {
    const { home, away } = score;
    let effectiveHome = home;
    let effectiveAway = away;

    if (selection === AsianHandicapSelection.Home) {
      effectiveHome = home + halfLine;
    } else if (selection === AsianHandicapSelection.Away) {
      effectiveAway = away + halfLine;
    } else {
      throw new Error(`Unsupported selection: ${selection}`);
    }

    if (effectiveHome > effectiveAway) {
      // Distinguish full / half win for non-zero line
      if (halfLine === 0) return MatchEventOutcome.Win;
      if (Math.abs(halfLine) === HALF_STEP) return MatchEventOutcome.Win;
      // For quarter splits, this half is a half-win
      return MatchEventOutcome.HalfWin;
    }
    if (effectiveHome === effectiveAway) return MatchEventOutcome.Push;
    if (effectiveHome < effectiveAway) {
      if (halfLine === 0) return MatchEventOutcome.Loss;
      if (Math.abs(halfLine) === HALF_STEP) return MatchEventOutcome.Loss;
      return MatchEventOutcome.HalfLoss;
    }
    return MatchEventOutcome.Loss;
  }

  /**
   * Aggregates the half-line results into a final result, applying
   * proper stake-splitting semantics for quarter lines.
   */
  static calculate(input: AsianHandicapInput): AsianHandicapResult {
    if (input.stake <= 0) {
      throw new Error('Stake must be positive');
    }
    if (input.decimalOdds <= 1) {
      throw new Error('Decimal odds must be greater than 1.0');
    }

    const halfLines = AsianHandicapCalculator.splitToHalfLines(input.market.line);
    const isSplit = halfLines.length === 2;
    const halfStake = isSplit ? input.stake / 2 : input.stake;

    let totalPayout = 0;
    let totalProfit = 0;
    const breakdown: AsianHandicapBreakdownLine[] = [];
    let anyLoss = false;
    let anyPush = false;
    let anyWin = false;

    for (const half of halfLines) {
      const outcome = AsianHandicapCalculator.resolveHalfLine(
        input.selection,
        half,
        input.score,
      );

      let payout = 0;
      let profit = 0;

      switch (outcome) {
        case MatchEventOutcome.Win:
          payout = halfStake * input.decimalOdds;
          profit = payout - halfStake;
          anyWin = true;
          break;
        case MatchEventOutcome.HalfWin:
          // Half-win: (stake/2 * odds) + stake/2 (original returned)
          payout = (halfStake / 2) * input.decimalOdds + halfStake / 2;
          profit = payout - halfStake;
          anyWin = true;
          break;
        case MatchEventOutcome.Push:
          payout = halfStake;
          profit = 0;
          anyPush = true;
          break;
        case MatchEventOutcome.HalfLoss:
          payout = halfStake / 2;
          profit = -(halfStake / 2);
          anyLoss = true;
          break;
        case MatchEventOutcome.Loss:
        default:
          payout = 0;
          profit = -halfStake;
          anyLoss = true;
          break;
      }

      totalPayout += payout;
      totalProfit += profit;
      breakdown.push({ halfLine: half, outcome, payout });
    }

    let aggregated: MatchEventOutcome;
    if (anyLoss && !anyWin) aggregated = MatchEventOutcome.Loss;
    else if (anyLoss && anyPush && !anyWin) aggregated = MatchEventOutcome.HalfLoss;
    else if (anyLoss && anyWin) aggregated = MatchEventOutcome.HalfLoss;
    else if (anyPush && !anyWin) aggregated = MatchEventOutcome.Push;
    else if (anyPush && anyWin) aggregated = MatchEventOutcome.HalfWin;
    else aggregated = MatchEventOutcome.Win;

    return {
      outcome: aggregated,
      payout: roundCurrency(totalPayout),
      profit: roundCurrency(totalProfit),
      breakdown,
    };
  }
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Convenience wrapper to validate a market's integrity.
 */
export function isValidHandicapLine(line: number): boolean {
  if (!Number.isFinite(line)) return false;
  const scaled = line * 4;
  return Math.abs(scaled - Math.round(scaled)) < 1e-9;
}

export function buildAsianHandicapMarket(
  homeLine: number,
  homeOdds: number,
  awayOdds: number,
): SelectionMarket {
  if (!isValidHandicapLine(homeLine)) {
    throw new Error(`Invalid Asian Handicap line: ${homeLine}`);
  }
  if (Math.abs(homeLine + (-homeLine)) > 1e-9) {
    // home line vs away line should mirror; away is the opposite.
    // Caller must compute the away line as -homeLine.
  }
  return {
    kind: 'ASIAN_HANDICAP',
    line: homeLine as AsianHandicapLine,
    selections: [
      {
        selection: AsianHandicapSelection.Home,
        line: homeLine as AsianHandicapLine,
        decimalOdds: homeOdds as Decimal,
      },
      {
        selection: AsianHandicapSelection.Away,
        line: (-homeLine) as AsianHandicapLine,
        decimalOdds: awayOdds as Decimal,
      },
    ],
  };
}

export const _internals = {
  roundCurrency,
};
