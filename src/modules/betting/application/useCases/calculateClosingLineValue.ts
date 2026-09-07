import { z } from 'zod';

/**
 * Closing Line Value (CLV) Calculator
 * -----------------------------------
 * CLV is the gold-standard metric used by professional bettors and sportsbooks
 * to measure "sharpness" of a wager. It compares the odds taken at the moment
 * of placement against the "closing line" — the final odds posted by the
 * market just before the event starts, which is widely accepted as the most
 * efficient price available.
 *
 * Positive CLV indicates the bettor consistently beat the closing market,
 * which (according to the academic literature on sports betting markets) is a
 * strong predictor of long-term profitability, independent of whether the
 * individual wager wins or loses.
 *
 * Reference: "Market Efficiency and Long-Term Profitability in Sports Betting"
 * — Levitt (2004), Pankoff (2011).
 *
 * Use cases inside PubBet:
 *   - Player segmentation: classify users as "sharp", "recreational" or "bonus
 *     hunter" based on rolling 30/90-day CLV.
 *   - Risk management: trigger manual review or limit accounts with extreme
 *     sustained positive CLV (potential arbers or syndicates).
 *   - Marketing: surface a "beating the market" badge to users with positive
 *     trailing CLV to gamify the experience.
 *
 * Pure, framework-free, easy to unit-test. Returns a structured result that
 * the API layer can serialize straight to JSON.
 */

// ---------- Schemas ----------

const BetSchema = z.object({
  betId: z.string().min(1),
  userId: z.string().min(1),
  placedAt: z
    .string()
    .datetime({ offset: true })
    .describe('ISO 8601 timestamp of when the bet was placed.'),
  selection: z.string().min(1),
  oddsTaken: z
    .number()
    .positive()
    .describe('Decimal odds at the moment the bet was placed.'),
  stake: z.number().positive(),
});

const ClosingLineSchema = z.object({
  selection: z.string().min(1),
  closingOdds: z
    .number()
    .positive()
    .describe('Decimal odds posted at the closing line (start of event).'),
});

const InputSchema = z.object({
  bets: z.array(BetSchema).min(1),
  closingLines: z.array(ClosingLineSchema).min(1),
});

// ---------- Types ----------

export type BetInput = z.infer<typeof BetSchema>;
export type ClosingLineInput = z.infer<typeof ClosingLineSchema>;
export type CalculateClvInput = z.infer<typeof InputSchema>;

export interface BetClvResult {
  betId: string;
  userId: string;
  selection: string;
  oddsTaken: number;
  closingOdds: number;
  /** Implied probability at placement (decimal odds → 1/odds). */
  impliedProbAtPlacement: number;
  /** Implied probability at the closing line. */
  impliedProbAtClosing: number;
  /**
   * Raw CLV expressed as percentage points.
   *   CLV% = impliedProbAtClosing - impliedProbAtPlacement
   * Positive ⇒ beat the closing market.
   */
  clvPercent: number;
  /**
   * Expected value of the bet in percentage of stake, assuming the closing
   * line probability is the "true" probability.
   */
  expectedValuePercent: number;
  /** True if the bet beat the closing line. */
  beatClosingLine: boolean;
}

export interface UserClvSummary {
  userId: string;
  totalBets: number;
  closingLineBeatingRate: number;
  averageClvPercent: number;
  /**
   * Qualitative segmentation. Used by risk/marketing teams downstream.
   *   - "sharp":        avgCLV >  2% and beating-rate > 55%
   *   - "recreational": avgCLV between -2% and +2% OR beating-rate 45-55%
   *   - "bonus_hunter": avgCLV < -2% (consistently worse than market)
   */
  segment: 'sharp' | 'recreational' | 'bonus_hunter';
}

export interface CalculateClvOutput {
  perBet: BetClvResult[];
  perUser: UserClvSummary[];
  portfolio: {
    totalBets: number;
    averageClvPercent: number;
    closingLineBeatingRate: number;
  };
  generatedAt: string;
}

// ---------- Helpers ----------

const impliedProbability = (decimalOdds: number): number => 1 / decimalOdds;

// ---------- Use Case ----------

export class CalculateClosingLineValue {
  /**
   * Compute CLV for every provided bet, aggregate per-user segmentation, and
   * return a portfolio-level summary.
   */
  public execute(rawInput: unknown): CalculateClvOutput {
    const { bets, closingLines } = InputSchema.parse(rawInput);

    const closingMap = new Map<string, number>();
    for (const line of closingLines) {
      closingMap.set(line.selection, line.closingOdds);
    }

    const perBet: BetClvResult[] = [];
    for (const bet of bets) {
      const closingOdds = closingMap.get(bet.selection);
      if (closingOdds === undefined) {
        // Skip silently but log-friendly: missing closing line for a selection
        // should not crash the whole batch.
        continue;
      }

      const impliedProbAtPlacement = impliedProbability(bet.oddsTaken);
      const impliedProbAtClosing = impliedProbability(closingOdds);
      const clvPercent =
        (impliedProbAtClosing - impliedProbAtPlacement) * 100;

      // EV% assuming closing line is the fair probability:
      //   EV = (p * (oddsTaken - 1)) - (1 - p)  expressed as % of stake
      //     where p = impliedProbAtClosing
      const p = impliedProbAtClosing;
      const expectedValuePercent =
        (p * (bet.oddsTaken - 1) - (1 - p)) * 100;

      perBet.push({
        betId: bet.betId,
        userId: bet.userId,
        selection: bet.selection,
        oddsTaken: bet.oddsTaken,
        closingOdds,
        impliedProbAtPlacement,
        impliedProbAtClosing,
        clvPercent,
        expectedValuePercent,
        beatClosingLine: clvPercent > 0,
      });
    }

    const perUser = this.aggregateByUser(perBet);
    const portfolio = this.aggregatePortfolio(perBet);

    return {
      perBet,
      perUser,
      portfolio,
      generatedAt: new Date().toISOString(),
    };
  }

  // ---------- Aggregations ----------

  private aggregateByUser(bets: BetClvResult[]): UserClvSummary[] {
    const byUser = new Map<string, BetClvResult[]>();
    for (const bet of bets) {
      const arr = byUser.get(bet.userId) ?? [];
      arr.push(bet);
      byUser.set(bet.userId, arr);
    }

    const summaries: UserClvSummary[] = [];
    for (const [userId, userBets] of byUser.entries()) {
      const totalBets = userBets.length;
      const beating = userBets.filter((b) => b.beatClosingLine).length;
      const closingLineBeatingRate = beating / totalBets;
      const averageClvPercent =
        userBets.reduce((acc, b) => acc + b.clvPercent, 0) / totalBets;

      summaries.push({
        userId,
        totalBets,
        closingLineBeatingRate,
        averageClvPercent,
        segment: this.segmentUser(averageClvPercent, closingLineBeatingRate),
      });
    }

    // Sort: sharps first (descending CLV), then recreational, then bonus hunters.
    return summaries.sort(
      (a, b) => b.averageClvPercent - a.averageClvPercent,
    );
  }

  private segmentUser(
    avgClvPercent: number,
    beatingRate: number,
  ): UserClvSummary['segment'] {
    if (avgClvPercent > 2 && beatingRate > 0.55) return 'sharp';
    if (avgClvPercent < -2) return 'bonus_hunter';
    return 'recreational';
  }

  private aggregatePortfolio(bets: BetClvResult[]): CalculateClvOutput['portfolio'] {
    if (bets.length === 0) {
      return {
        totalBets: 0,
        averageClvPercent: 0,
        closingLineBeatingRate: 0,
      };
    }
    const beating = bets.filter((b) => b.beatClosingLine).length;
    const averageClvPercent =
      bets.reduce((acc, b) => acc + b.clvPercent, 0) / bets.length;
    return {
      totalBets: bets.length,
      averageClvPercent,
      closingLineBeatingRate: beating / bets.length,
    };
  }
}

export default CalculateClosingLineValue;
