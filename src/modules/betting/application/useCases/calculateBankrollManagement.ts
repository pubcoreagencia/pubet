import { BettingOdds, BankrollConfig, BetRecommendation } from '../types/betting.types';

/**
 * Bankroll Management & Risk-Aware Bet Sizing Engine
 * Implements Fractional Kelly Criterion combined with multi-bet exposure tracking
 * and drawdown-aware position sizing for PubBet's high-frequency betting squad.
 */

const DEFAULT_CONFIG: BankrollConfig = {
  initialBankroll: 10000,
  maxStakePercentage: 0.05,
  kellyFraction: 0.25,
  maxDrawdownPercentage: 0.20,
  minEdge: 0.03,
  maxConcurrentBets: 15,
  maxExposurePercentage: 0.35,
  confidenceThreshold: 0.55,
};

export function calculateBankrollManagement(
  odds: BettingOdds[],
  config: Partial<BankrollConfig> = {},
  currentExposure: number = 0,
  recentForm: number[] = [],
): {
  recommendations: BetRecommendation[];
  totalAllocated: number;
  remainingBankroll: number;
  exposureRatio: number;
  riskScore: number;
} {
  const cfg: BankrollConfig = { ...DEFAULT_CONFIG, ...config };
  const recommendations: BetRecommendation[] = [];

  const drawdown = calculateDrawdown(recentForm);
  const drawdownFactor = Math.max(0.25, 1 - drawdown / cfg.maxDrawdownPercentage);
  const currentExposureRatio = currentExposure / cfg.initialBankroll;
  const exposureHeadroom = Math.max(0, cfg.maxExposurePercentage - currentExposureRatio);

  const sortedOdds = [...odds]
    .filter((o) => o.edge >= cfg.minEdge && o.confidence >= cfg.confidenceThreshold)
    .sort((a, b) => b.expectedValue - a.expectedValue)
    .slice(0, cfg.maxConcurrentBets);

  let totalAllocated = 0;

  for (const odd of sortedOdds) {
    const fullKelly = calculateFullKelly(odd.impliedProbability, odd.decimalOdds);
    if (fullKelly <= 0) continue;

    const fractionalKelly = fullKelly * cfg.kellyFraction * drawdownFactor;
    const cappedStake = Math.min(fractionalKelly, cfg.maxStakePercentage);
    const remainingExposure = exposureHeadroom - totalAllocated / cfg.initialBankroll;

    if (remainingExposure <= 0) break;

    const finalStakeRatio = Math.min(cappedStake, remainingExposure);
    const stakeAmount = +(finalStakeRatio * cfg.initialBankroll).toFixed(2);

    if (stakeAmount < 1) continue;

    const expectedProfit = +(stakeAmount * (odd.decimalOdds - 1) * odd.impliedProbability - stakeAmount * (1 - odd.impliedProbability)).toFixed(2);

    recommendations.push({
      eventId: odd.eventId,
      selection: odd.selection,
      bookmaker: odd.bookmaker,
      decimalOdds: odd.decimalOdds,
      stakeAmount,
      stakePercentage: +(finalStakeRatio * 100).toFixed(3),
      expectedProfit,
      expectedValue: odd.expectedValue,
      kellyFraction: cfg.kellyFraction,
      riskAdjusted: true,
      drawdownFactor: +drawdownFactor.toFixed(3),
      confidence: odd.confidence,
      timestamp: new Date().toISOString(),
    });

    totalAllocated += stakeAmount;
  }

  const remainingBankroll = +(cfg.initialBankroll - totalAllocated - currentExposure).toFixed(2);
  const exposureRatio = +((currentExposure + totalAllocated) / cfg.initialBankroll).toFixed(4);
  const riskScore = computeRiskScore(recommendations, drawdown, exposureRatio);

  return { recommendations, totalAllocated: +totalAllocated.toFixed(2), remainingBankroll, exposureRatio, riskScore };
}

function calculateFullKelly(trueProbability: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  if (b <= 0) return 0;
  const q = 1 - trueProbability;
  const kelly = (b * trueProbability - q) / b;
  return Math.max(0, kelly);
}

function calculateDrawdown(recentPnL: number[]): number {
  if (!recentPnL.length) return 0;
  let peak = 0;
  let maxDD = 0;
  let running = 0;
  for (const pnl of recentPnL) {
    running += pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }
  return +(maxDD / Math.max(peak, 1)).toFixed(4);
}

function computeRiskScore(recs: BetRecommendation[], drawdown: number, exposureRatio: number): number {
  if (!recs.length) return 0;
  const avgEdge = recs.reduce((s, r) => s + r.expectedValue, 0) / recs.length;
  const concentration = Math.max(...recs.map((r) => r.stakePercentage)) / 100;
  const score = (1 - drawdown) * 0.4 + Math.min(avgEdge / 0.15, 1) * 0.3 + (1 - exposureRatio) * 0.2 + (1 - concentration) * 0.1;
  return +(score * 100).toFixed(2);
}
