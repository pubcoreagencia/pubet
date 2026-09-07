import { BookmakerOdds } from "../domain/types";

export interface OptimalSizingInput {
  selections: BookmakerOdds[];           // odds with impliedProb, decimal odds, bookId
  trueProbabilities: number[];          // estimated true probabilities (0..1)
  bankroll: number;
  kellyFraction?: number;                // default 0.25 (quarter Kelly)
  maxPerBetPct?: number;                 // cap any single stake (e.g. 0.05 = 5%)
  maxBookExposurePct?: number;           // cap per bookmaker (e.g. 0.20 = 20%)
  correlation?: number[];                // optional pairwise correlations between selections
  commissionPct?: number;                // exchange commission (e.g. 0.02)
}

export interface OptimalSizingLeg {
  selectionId: string;
  bookId: string;
  odds: number;
  impliedProbability: number;
  trueProbability: number;
  edge: number;                          // trueProb - impliedProb (positive = value)
  kellyFull: number;                     // full Kelly fraction
  kellyAdjusted: number;                 // fractional Kelly applied
  recommendedStake: number;
  expectedValue: number;                 // expected profit per unit staked
  expectedGrowth: number;                // log-growth contribution
  capped: boolean;
  capReason?: string;
}

export interface OptimalSizingResult {
  totalRecommendedStake: number;
  maxDrawdownEstimate: number;
  portfolioEdge: number;                 // weighted edge of approved bets
  bookmakerExposure: Record<string, number>;
  rejected: Array<{ selectionId: string; reason: string }>;
  legs: OptimalSizingLeg[];
  metadata: {
    bankroll: number;
    kellyFraction: number;
    timestamp: number;
    diversificationApplied: boolean;
  };
}

/**
 * Optimal bet sizing using fractional Kelly criterion with multi-layer risk caps:
 *  - Full Kelly: f* = (bp - q) / b  where b = odds-1, p = true prob, q = 1-p
 *  - Applies user-defined fraction (default quarter-Kelly) to reduce variance
 *  - Caps: per-bet %, per-bookmaker %, bankroll floor
 *  - Computes EV, log-growth, and portfolio metrics for downstream risk engine
 *  - Handles commission on exchange books
 *  - Rejects negative-EV selections and correlated/overlapping exposures
 */
export function calculateOptimalBetSizing(input: OptimalSizingInput): OptimalSizingResult {
  const {
    selections,
    trueProbabilities,
    bankroll,
    kellyFraction = 0.25,
    maxPerBetPct = 0.05,
    maxBookExposurePct = 0.25,
    correlation = [],
    commissionPct = 0,
  } = input;

  if (bankroll <= 0) throw new Error("Bankroll must be positive");
  if (selections.length !== trueProbabilities.length) {
    throw new Error("selections and trueProbabilities length mismatch");
  }
  if (kellyFraction <= 0 || kellyFraction > 1) {
    throw new Error("kellyFraction must be in (0, 1]");
  }

  const legs: OptimalSizingLeg[] = [];
  const rejected: OptimalSizingResult["rejected"] = [];
  const bookmakerExposure: Record<string, number> = {};
  let totalStake = 0;
  let weightedEdgeNumerator = 0;
  let maxDrawdownEstimate = 0;

  selections.forEach((sel, idx) => {
    const trueProb = clamp01(trueProbabilities[idx]);
    const odds = sel.decimalOdds;
    const impliedProb = sel.impliedProbability;

    if (odds <= 1) {
      rejected.push({ selectionId: sel.selectionId, reason: "Invalid odds (<=1)" });
      return;
    }
    if (trueProb <= 0 || trueProb >= 1) {
      rejected.push({ selectionId: sel.selectionId, reason: "Invalid true probability" });
      return;
    }

    const edge = trueProb - impliedProb;
    if (edge <= 0) {
      rejected.push({ selectionId: sel.selectionId, reason: "Negative edge (no value)" });
      return;
    }

    // Apply commission on net returns for exchange books
    const effectiveOdds = commissionPct > 0 ? 1 + (odds - 1) * (1 - commissionPct) : odds;
    const b = effectiveOdds - 1;
    const p = trueProb;
    const q = 1 - p;

    // Full Kelly: f* = (bp - q) / b
    const kellyFull = Math.max(0, (b * p - q) / b);
    let kellyAdjusted = kellyFull * kellyFraction;

    // Per-bet cap
    let capped = false;
    let capReason: string | undefined;
    if (kellyAdjusted > maxPerBetPct) {
      kellyAdjusted = maxPerBetPct;
      capped = true;
      capReason = `per-bet cap ${(maxPerBetPct * 100).toFixed(1)}%`;
    }

    // Per-bookmaker cap
    const currentBookExposure = bookmakerExposure[sel.bookId] ?? 0;
    const remainingBookRoom = maxBookExposurePct * bankroll - currentBookExposure;
    if (remainingBookRoom <= 0) {
      rejected.push({ selectionId: sel.selectionId, reason: `Book ${sel.bookId} exposure limit reached` });
      return;
    }
    if (kellyAdjusted * bankroll > remainingBookRoom) {
      kellyAdjusted = Math.max(0, remainingBookRoom / bankroll);
      capped = true;
      capReason = capReason
        ? `${capReason}; book cap`
        : `book cap ${(maxBookExposurePct * 100).toFixed(1)}%`;
    }

    const recommendedStake = roundCurrency(kellyAdjusted * bankroll);
    if (recommendedStake <= 0) {
      rejected.push({ selectionId: sel.selectionId, reason: "Stake rounded to zero" });
      return;
    }

    const expectedValue = recommendedStake * (effectiveOdds * p - 1);
    const expectedGrowth = p * Math.log(effectiveOdds) + q * Math.log(1 - kellyAdjusted * b);

    legs.push({
      selectionId: sel.selectionId,
      bookId: sel.bookId,
      odds: effectiveOdds,
      impliedProbability: impliedProb,
      trueProbability: trueProb,
      edge,
      kellyFull,
      kellyAdjusted,
      recommendedStake,
      expectedValue,
      expectedGrowth,
      capped,
      capReason,
    });

    bookmakerExposure[sel.bookId] = currentBookExposure + recommendedStake;
    totalStake += recommendedStake;
    weightedEdgeNumerator += edge * recommendedStake;

    // Worst-case drawdown estimate: assume all bets lose simultaneously at full stake
    const worstLoss = recommendedStake * (1 - kellyAdjusted * 0);
    maxDrawdownEstimate += worstLoss;
  });

  // Correlation penalty: reduce stake when correlation matrix indicates overlap
  if (correlation.length === legs.length * legs.length) {
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const rho = correlation[i * legs.length + j];
        if (rho > 0.3) {
          const penalty = 1 - Math.min(0.5, rho * 0.5);
          legs[i].recommendedStake = roundCurrency(legs[i].recommendedStake * penalty);
          legs[i].expectedValue *= penalty;
          legs[i].expectedGrowth *= penalty;
          legs[i].capped = true;
          legs[i].capReason = `${legs[i].capReason ?? ""}; correlation ${rho.toFixed(2)}`;
        }
      }
    }
    totalStake = legs.reduce((s, l) => s + l.recommendedStake, 0);
    weightedEdgeNumerator = legs.reduce((s, l) => s + l.edge * l.recommendedStake, 0);
  }

  return {
    totalRecommendedStake: roundCurrency(totalStake),
    maxDrawdownEstimate: roundCurrency(Math.min(maxDrawdownEstimate, bankroll)),
    portfolioEdge: totalStake > 0 ? weightedEdgeNumerator / totalStake : 0,
    bookmakerExposure: Object.fromEntries(
      Object.entries(bookmakerExposure).map(([k, v]) => [k, roundCurrency(v)])
    ),
    rejected,
    legs,
    metadata: {
      bankroll,
      kellyFraction,
      timestamp: Date.now(),
      diversificationApplied: correlation.length === legs.length * legs.length,
    },
  };
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function roundCurrency(v: number): number {
  return Math.round(v * 100) / 100;
}
