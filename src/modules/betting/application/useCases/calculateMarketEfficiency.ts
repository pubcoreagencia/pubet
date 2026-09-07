import { z } from 'zod';

/**
 * Market Efficiency & Vigorish Calculator
 * ----------------------------------------
 * Calculates the overround (vig/juice), true implied probabilities, and
 * the market efficiency index for a given set of decimal odds across
 * mutually exclusive outcomes (e.g., 1X2, moneyline, outright winner).
 *
 * Outputs:
 *  - rawImpliedProbability: naive 1/odds (does not sum to 1 due to vig)
 *  - fairProbability:         vig-removed (normalized) true probability
 *  - fairOdds:                 decimal odds that would make fairProb sum to 1
 *  - overround:                bookmaker margin (e.g. 0.05 = 5% vig)
 *  - marketEfficiency:         1 - overround (closer to 1 = sharper market)
 *  - kellyFraction:            suggested Kelly stake % for a bettor with an
 *                              estimated edge vs the fair probability
 *  - valueEdge:                edge of the offered odds vs fair probability
 */

export const MarketInputSchema = z.object({
  outcomes: z
    .array(
      z.object({
        label: z.string().min(1),
        decimalOdds: z.number().positive().finite(),
        estimatedTrueProbability: z.number().min(0).max(1).optional(),
      }),
    )
    .min(2)
    .max(64),
  bankroll: z.number().nonnegative().finite().default(0),
  fractionOfKelly: z.number().min(0).max(1).default(0.25),
});

export type MarketInput = z.infer<typeof MarketInputSchema>;

export type OutcomeAnalysis = {
  label: string;
  decimalOdds: number;
  rawImpliedProbability: number;
  fairProbability: number;
  fairOdds: number;
  valueEdge: number;
  kellyFraction: number;
  kellyStake: number;
};

export type MarketEfficiencyResult = {
  outcomeCount: number;
  overround: number;
  marketEfficiency: number;
  marketQuality: 'sharp' | 'semi-sharp' | 'soft' | 'predatory';
  totalRawProbability: number;
  isValidMarket: boolean;
  outcomes: OutcomeAnalysis[];
  bestValueOutcome: OutcomeAnalysis | null;
  timestamp: string;
};

const classifyMarket = (efficiency: number): MarketEfficiencyResult['marketQuality'] => {
  if (efficiency >= 0.98) return 'sharp';
  if (efficiency >= 0.95) return 'semi-sharp';
  if (efficiency >= 0.9) return 'soft';
  return 'predatory';
};

export function calculateMarketEfficiency(input: MarketInput): MarketEfficiencyResult {
  const parsed = MarketInputSchema.parse(input);
  const { outcomes, bankroll, fractionOfKelly } = parsed;

  const rawProbs = outcomes.map((o) => ({
    label: o.label,
    decimalOdds: o.decimalOdds,
    raw: 1 / o.decimalOdds,
    estimated: o.estimatedTrueProbability,
  }));

  const totalRaw = rawProbs.reduce((acc, p) => acc + p.raw, 0);
  const overround = totalRaw - 1;
  const efficiency = Math.max(0, 1 - overround);

  const analyzed: OutcomeAnalysis[] = rawProbs.map((p) => {
    const fairProbability = totalRaw > 0 ? p.raw / totalRaw : 0;
    const fairOdds = fairProbability > 0 ? 1 / fairProbability : Number.POSITIVE_INFINITY;

    let valueEdge = 0;
    let kellyFraction = 0;
    let kellyStake = 0;

    if (typeof p.estimated === 'number' && p.estimated > 0) {
      valueEdge = (p.decimalOdds * p.estimated) - 1;
      if (valueEdge > 0 && p.decimalOdds > 1) {
        const b = p.decimalOdds - 1;
        kellyFraction = (b * p.estimated - (1 - p.estimated)) / b;
        if (kellyFraction < 0) kellyFraction = 0;
        kellyFraction = Math.min(kellyFraction, 1) * fractionOfKelly;
        kellyStake = bankroll * kellyFraction;
      }
    }

    return {
      label: p.label,
      decimalOdds: p.decimalOdds,
      rawImpliedProbability: p.raw,
      fairProbability,
      fairOdds: Number.isFinite(fairOdds) ? Number(fairOdds.toFixed(4)) : 0,
      valueEdge: Number(valueEdge.toFixed(6)),
      kellyFraction: Number(kellyFraction.toFixed(6)),
      kellyStake: Number(kellyStake.toFixed(2)),
    };
  });

  const bestValue = analyzed
    .filter((o) => o.valueEdge > 0)
    .sort((a, b) => b.valueEdge - a.valueEdge)[0] ?? null;

  return {
    outcomeCount: outcomes.length,
    overround: Number(overround.toFixed(6)),
    marketEfficiency: Number(efficiency.toFixed(6)),
    marketQuality: classifyMarket(efficiency),
    totalRawProbability: Number(totalRaw.toFixed(6)),
    isValidMarket: totalRaw > 1 && outcomes.length >= 2,
    outcomes: analyzed,
    bestValueOutcome: bestValue,
    timestamp: new Date().toISOString(),
  };
}

export const marketEfficiencyUseCase = {
  name: 'calculateMarketEfficiency',
  execute: calculateMarketEfficiency,
};

export default calculateMarketEfficiency;
