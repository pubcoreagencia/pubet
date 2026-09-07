import { z } from 'zod';

/**
 * Domain schema describing a single bookmaker quote for a given outcome.
 */
const OddsQuoteSchema = z.object({
  bookmakerId: z.string().min(1),
  bookmakerName: z.string().min(1),
  outcome: z.enum(['home', 'draw', 'away']),
  decimalOdds: z.number().positive().finite(),
  maxStake: z.number().nonnegative().optional(),
  isLive: z.boolean().optional().default(false),
  updatedAt: z.string().datetime().optional(),
});

export type OddsQuote = z.infer<typeof OddsQuoteSchema>;

/**
 * True probabilities estimated by the pricing engine (sum to 1.0 across outcomes).
 */
const TrueProbabilitySchema = z.object({
  home: z.number().min(0).max(1),
  draw: z.number().min(0).max(1),
  away: z.number().min(0).max(1),
});

export type TrueProbability = z.infer<typeof TrueProbabilitySchema>;

export const ValueBetsInputSchema = z.object({
  eventId: z.string().min(1),
  sport: z.string().min(1),
  market: z.enum(['1X2', 'match_winner', 'moneyline']).default('1X2'),
  quotes: z.array(OddsQuoteSchema).min(1),
  trueProbability: TrueProbabilitySchema,
  /** Kelly fraction cap, e.g. 0.25 means we never wager more than 25% of bankroll per bet. */
  kellyFractionCap: z.number().min(0).max(1).default(0.25),
  /** Bankroll used for stake sizing. */
  bankroll: z.number().positive().default(1000),
  /** Minimum edge (in percentage points) to consider a bet valuable. */
  minEdgePct: z.number().min(0).max(100).default(2),
});

export type ValueBetsInput = z.infer<typeof ValueBetsInputSchema>;

export interface ValueBet {
  eventId: string;
  sport: string;
  market: string;
  bookmakerId: string;
  bookmakerName: string;
  outcome: OddsQuote['outcome'];
  decimalOdds: number;
  fairDecimalOdds: number;
  impliedProbability: number;
  trueProbability: number;
  edgePct: number; // (trueProb * odds) - 1 expressed as percentage
  expectedValue: number; // expected profit per 1 unit staked
  kellyStake: number; // fractional Kelly stake in units of bankroll
  recommendedStake: number; // absolute currency stake respecting the cap
  confidence: 'low' | 'medium' | 'high';
}

export interface ValueBetsOutput {
  eventId: string;
  sport: string;
  market: string;
  generatedAt: string;
  valueBets: ValueBet[];
  bestValueBet?: ValueBet;
  totalEdgePct: number;
  count: number;
}

/**
 * Convert decimal odds to implied probability, removing the bookmaker overround
 * to normalize the market for each bookmaker.
 */
function impliedProbabilityFromQuote(quote: OddsQuote): number {
  return 1 / quote.decimalOdds;
}

function fairDecimalOdds(trueProbability: number): number {
  if (trueProbability <= 0) return Number.POSITIVE_INFINITY;
  return 1 / trueProbability;
}

/**
 * Calculate the full Kelly fraction for a binary bet with decimal odds b and
 * win probability p. Result is in [0, 1] representing fraction of bankroll.
 */
function fullKellyFraction(trueProb: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  const f = (b * trueProb - (1 - trueProb)) / b;
  return f > 0 ? f : 0;
}

function classifyConfidence(edgePct: number): ValueBet['confidence'] {
  if (edgePct >= 8) return 'high';
  if (edgePct >= 4) return 'medium';
  return 'low';
}

/**
 * Use case: calculateValueBets
 *
 * Scans a list of bookmaker quotes for a single event, compares them against
 * the pricing engine's true probabilities and returns the wagers that carry a
 * positive expected value (a.k.a. "value bets"). Also produces Kelly-sized
 * recommendations respecting the configured fraction cap.
 *
 * This is intentionally pure and side-effect free so it can be called from
 * cron jobs, edge workers or in-process HTTP handlers.
 */
export function calculateValueBets(rawInput: unknown): ValueBetsOutput {
  const input = ValueBetsInputSchema.parse(rawInput);

  const candidates: ValueBet[] = [];

  for (const quote of input.quotes) {
    const trueProb = input.trueProbability[quote.outcome];
    if (!Number.isFinite(trueProb) || trueProb <= 0) continue;

    const fairOdds = fairDecimalOdds(trueProb);
    const implied = impliedProbabilityFromQuote(quote);
    const edgePct = (trueProb * quote.decimalOdds - 1) * 100;
    const expectedValue = trueProb * (quote.decimalOdds - 1) - (1 - trueProb);

    if (edgePct < input.minEdgePct) continue;

    const fullKelly = fullKellyFraction(trueProb, quote.decimalOdds);
    const cappedKelly = Math.min(fullKelly, input.kellyFractionCap);
    const recommendedStake = Number((cappedKelly * input.bankroll).toFixed(2));

    candidates.push({
      eventId: input.eventId,
      sport: input.sport,
      market: input.market,
      bookmakerId: quote.bookmakerId,
      bookmakerName: quote.bookmakerName,
      outcome: quote.outcome,
      decimalOdds: quote.decimalOdds,
      fairDecimalOdds: Number(fairOdds.toFixed(4)),
      impliedProbability: Number(implied.toFixed(4)),
      trueProbability: Number(trueProb.toFixed(4)),
      edgePct: Number(edgePct.toFixed(4)),
      expectedValue: Number(expectedValue.toFixed(4)),
      kellyStake: Number(cappedKelly.toFixed(4)),
      recommendedStake,
      confidence: classifyConfidence(edgePct),
    });
  }

  candidates.sort((a, b) => b.edgePct - a.edgePct);

  const totalEdgePct = candidates.reduce((acc, c) => acc + c.edgePct, 0);

  return {
    eventId: input.eventId,
    sport: input.sport,
    market: input.market,
    generatedAt: new Date().toISOString(),
    valueBets: candidates,
    bestValueBet: candidates[0],
    totalEdgePct: Number(totalEdgePct.toFixed(4)),
    count: candidates.length,
  };
}

export default calculateValueBets;
