import { EventEmitter } from 'events';

/**
 * Market types supported in live betting context.
 */
export type LiveMarketType = 'MATCH_WINNER' | 'TOTAL_POINTS' | 'HANDICAP' | 'NEXT_GOAL';

export interface LiveSelection {
  id: string;
  marketType: LiveMarketType;
  selectionKey: string;
  baseOdds: number;
  currentVolume: number;
  maxExposure: number;
  suspended: boolean;
}

export interface LiveMarketSnapshot {
  marketId: string;
  eventId: string;
  selections: LiveSelection[];
  timestamp: number;
}

export interface LiveOddsInput {
  market: LiveMarketSnapshot;
  selectionId: string;
  stake: number;
  deltaVolume: number;
  bookmakerMargin: number;
  volatilityFactor: number;
}

export interface LiveOddsResult {
  marketId: string;
  selectionId: string;
  newOdds: number;
  previousOdds: number;
  movement: number;
  liability: number;
  overround: number;
  suspended: boolean;
  reason?: string;
  computedAt: number;
}

const MIN_ODDS = 1.01;
const MAX_ODDS = 1000;
const SUSPEND_THRESHOLD = 0.95;

export class LiveOddsCalculator extends EventEmitter {
  private readonly snapshots = new Map<string, LiveMarketSnapshot>();

  registerMarket(snapshot: LiveMarketSnapshot): void {
    this.snapshots.set(snapshot.marketId, snapshot);
    this.emit('market:registered', snapshot);
  }

  getMarket(marketId: string): LiveMarketSnapshot | undefined {
    return this.snapshots.get(marketId);
  }

  calculate(input: LiveOddsInput): LiveOddsResult {
    const target = input.market.selections.find((s) => s.id === input.selectionId);
    if (!target) {
      throw new Error(`Selection ${input.selectionId} not found in market ${input.market.marketId}`);
    }

    const previousOdds = target.baseOdds;
    const projectedVolume = Math.max(0, target.currentVolume + input.deltaVolume);
    const projectedLiability = projectedVolume * previousOdds;

    if (target.suspended || projectedLiability >= target.maxExposure * SUSPEND_THRESHOLD) {
      const suspendedResult: LiveOddsResult = {
        marketId: input.market.marketId,
        selectionId: target.id,
        newOdds: previousOdds,
        previousOdds,
        movement: 0,
        liability: projectedLiability,
        overround: this.computeOverround(input.market),
        suspended: true,
        reason: target.suspended ? 'market_suspended' : 'exposure_limit_reached',
        computedAt: Date.now(),
      };
      this.emit('odds:suspended', suspendedResult);
      return suspendedResult;
    }

    const exposureRatio = projectedLiability / Math.max(1, target.maxExposure);
    const imbalancePenalty = this.applyImbalanceAdjustment(input.market, target.id, input.deltaVolume);
    const volatility = Math.min(Math.max(input.volatilityFactor, 0), 1);

    const rawMovement =
      exposureRatio * 0.35 + imbalancePenalty * 0.5 + volatility * 0.15;

    const adjustedMovement = Number(rawMovement.toFixed(4));
    const newOddsRaw = previousOdds * (1 + adjustedMovement);
    const newOdds = Math.min(MAX_ODDS, Math.max(MIN_ODDS, Number(newOddsRaw.toFixed(2))));

    const result: LiveOddsResult = {
      marketId: input.market.marketId,
      selectionId: target.id,
      newOdds,
      previousOdds,
      movement: Number((newOdds - previousOdds).toFixed(4)),
      liability: Number(projectedLiability.toFixed(2)),
      overround: this.computeOverround(input.market),
      suspended: false,
      computedAt: Date.now(),
    };

    target.baseOdds = newOdds;
    target.currentVolume = projectedVolume;
    this.emit('odds:recalculated', result);
    return result;
  }

  private applyImbalanceAdjustment(
    market: LiveMarketSnapshot,
    selectionId: string,
    deltaVolume: number,
  ): number {
    if (market.selections.length < 2) return 0;
    const others = market.selections.filter((s) => s.id !== selectionId);
    const othersVolume = others.reduce((sum, s) => sum + s.currentVolume, 0) || 1;
    const subjectVolume = (market.selections.find((s) => s.id === selectionId)?.currentVolume ?? 0) + deltaVolume;
    const ratio = subjectVolume / (othersVolume + subjectVolume);
    const fairRatio = 1 / market.selections.length;
    return (ratio - fairRatio) * 2;
  }

  private computeOverround(market: LiveMarketSnapshot): number {
    const sum = market.selections
      .filter((s) => !s.suspended)
      .reduce((acc, s) => acc + (1 / Math.max(MIN_ODDS, s.baseOdds)), 0);
    return Number((sum - 1).toFixed(4));
  }
}

export const liveOddsCalculator = new LiveOddsCalculator();

export function buildLiveOddsHandler(calculator: LiveOddsCalculator = liveOddsCalculator) {
  return function handleLiveOdds(input: LiveOddsInput): LiveOddsResult {
    const market = calculator.getMarket(input.market.marketId) ?? input.market;
    if (!calculator.getMarket(input.market.marketId)) {
      calculator.registerMarket(market);
    }
    return calculator.calculate({ ...input, market });
  };
}
