import { BetSide, BetSelection } from '../domain/types';

interface Order {
  id: string;
  selectionId: string;
  side: BetSide;
  price: number;
  stake: number;
  remainingStake: number;
  timestamp: number;
  userId: string;
}

interface MatchResult {
  orderId: string;
  matchedStake: number;
  avgMatchedPrice: number;
  counterpartyOrders: Array<{ orderId: string; price: number; stake: number }>;
}

interface OrderBookLevel {
  price: number;
  totalStake: number;
  orderCount: number;
}

interface LimitOrderBookSnapshot {
  selectionId: string;
  back: OrderBookLevel[];
  lay: OrderBookLevel[];
  bestBack: number | null;
  bestLay: number | null;
  spread: number | null;
  liquidity: number;
  midPrice: number | null;
}

const PRICE_TOLERANCE = 0.0001;

const aggregateLevels = (orders: Order[]): OrderBookLevel[] => {
  const levelMap = new Map<number, OrderBookLevel>();
  for (const order of orders) {
    if (order.remainingStake <= 0) continue;
    const roundedPrice = Math.round(order.price * 1000) / 1000;
    const existing = levelMap.get(roundedPrice);
    if (existing) {
      existing.totalStake += order.remainingStake;
      existing.orderCount += 1;
    } else {
      levelMap.set(roundedPrice, {
        price: roundedPrice,
        totalStake: order.remainingStake,
        orderCount: 1,
      });
    }
  }
  return Array.from(levelMap.values());
};

export class LimitOrderBook {
  private readonly orders = new Map<string, Order>();
  private readonly selectionIndex = new Map<string, Set<string>>();

  addOrder(params: {
    id: string;
    selectionId: string;
    side: BetSide;
    price: number;
    stake: number;
    userId: string;
  }): MatchResult | null {
    if (params.price <= 1 || params.stake <= 0) {
      throw new Error('Invalid order parameters: price must be > 1 and stake must be > 0');
    }

    const order: Order = {
      id: params.id,
      selectionId: params.selectionId,
      side: params.side,
      price: params.price,
      stake: params.stake,
      remainingStake: params.stake,
      timestamp: Date.now(),
      userId: params.userId,
    };

    const match = this.matchOrder(order);
    this.persistOrder(order);

    if (order.remainingStake <= 0) {
      return match;
    }
    return match && match.matchedStake > 0 ? match : null;
  }

  private persistOrder(order: Order): void {
    if (order.remainingStake <= 0) {
      this._removeOrderFromIndex(order);
      return;
    }
    this.orders.set(order.id, order);
    const set = this.selectionIndex.get(order.selectionId) ?? new Set<string>();
    set.add(order.id);
    this.selectionIndex.set(order.selectionId, set);
  }

  private removeOrder(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    this._removeOrderFromIndex(order);
    this.orders.delete(orderId);
  }

  private _removeOrderFromIndex(order: Order): void {
    const set = this.selectionIndex.get(order.selectionId);
    if (set) {
      set.delete(order.id);
      if (set.size === 0) {
        this.selectionIndex.delete(order.selectionId);
      }
    }
  }

  private matchOrder(order: Order): MatchResult | null {
    const counterSide: BetSide = order.side === 'BACK' ? 'LAY' : 'BACK';
    const candidates = this.findMatchingCandidates(order.selectionId, counterSide, order.price);

    if (candidates.length === 0) {
      return null;
    }

    let remaining = order.remainingStake;
    let weightedPriceSum = 0;
    let matchedTotal = 0;
    const fills: Array<{ orderId: string; price: number; stake: number }> = [];

    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const fillStake = Math.min(remaining, candidate.remainingStake);
      const fillPrice = candidate.price;

      weightedPriceSum += fillPrice * fillStake;
      matchedTotal += fillStake;
      fills.push({ orderId: candidate.id, price: fillPrice, stake: fillStake });

      candidate.remainingStake -= fillStake;
      remaining -= fillStake;

      if (candidate.remainingStake <= 0) {
        this.removeOrder(candidate.id);
      }
    }

    order.remainingStake = remaining;

    if (matchedTotal <= 0) {
      return null;
    }

    return {
      orderId: order.id,
      matchedStake: matchedTotal,
      avgMatchedPrice: weightedPriceSum / matchedTotal,
      counterpartyOrders: fills,
    };
  }

  private findMatchingCandidates(
    selectionId: string,
    counterSide: BetSide,
    incomingPrice: number,
  ): Order[] {
    const ids = this.selectionIndex.get(selectionId);
    if (!ids) return [];

    const candidates: Order[] = [];
    for (const id of ids) {
      const o = this.orders.get(id);
      if (!o || o.remainingStake <= 0) continue;
      if (o.side !== counterSide) continue;
      const priceMatches =
        counterSide === 'BACK' ? o.price >= incomingPrice - PRICE_TOLERANCE : o.price <= incomingPrice + PRICE_TOLERANCE;
      if (priceMatches) {
        candidates.push(o);
      }
    }

    candidates.sort((a, b) => {
      if (counterSide === 'BACK') {
        if (Math.abs(a.price - b.price) > PRICE_TOLERANCE) return a.price - b.price;
        return a.timestamp - b.timestamp;
      }
      if (Math.abs(a.price - b.price) > PRICE_TOLERANCE) return b.price - a.price;
      return a.timestamp - b.timestamp;
    });

    return candidates;
  }

  cancelOrder(orderId: string, userId: string): boolean {
    const order = this.orders.get(orderId);
    if (!order || order.userId !== userId) return false;
    this.removeOrder(orderId);
    return true;
  }

  getSnapshot(selectionId: string): LimitOrderBookSnapshot {
    const ids = this.selectionIndex.get(selectionId);
    const allOrders: Order[] = [];
    if (ids) {
      for (const id of ids) {
        const o = this.orders.get(id);
        if (o && o.remainingStake > 0) allOrders.push(o);
      }
    }

    const backOrders = allOrders.filter((o) => o.side === 'BACK').sort((a, b) => b.price - a.price);
    const layOrders = allOrders.filter((o) => o.side === 'LAY').sort((a, b) => a.price - b.price);

    const back = aggregateLevels(backOrders);
    const lay = aggregateLevels(layOrders);

    const bestBack = back.length > 0 ? back[0].price : null;
    const bestLay = lay.length > 0 ? lay[0].price : null;
    const spread = bestBack !== null && bestLay !== null ? bestLay - bestBack : null;
    const liquidity = back.reduce((sum, l) => sum + l.totalStake, 0) + lay.reduce((sum, l) => sum + l.totalStake, 0);
    const midPrice = bestBack !== null && bestLay !== null ? (bestBack + bestLay) / 2 : null;

    return {
      selectionId,
      back,
      lay,
      bestBack,
      bestLay,
      spread,
      liquidity,
      midPrice,
    };
  }

  getAllSnapshots(): LimitOrderBookSnapshot[] {
    const snapshots: LimitOrderBookSnapshot[] = [];
    for (const selectionId of this.selectionIndex.keys()) {
      snapshots.push(this.getSnapshot(selectionId));
    }
    return snapshots;
  }
}

export const calculateLimitOrderBook = (
  selections: BetSelection[],
  incoming: { selectionId: string; side: BetSide; price: number; stake: number; userId: string },
): { match: MatchResult | null; snapshot: LimitOrderBookSnapshot } => {
  const book = new LimitOrderBook();

  for (const sel of selections) {
    for (const order of sel.pendingOrders ?? []) {
      book.addOrder({
        id: order.id,
        selectionId: sel.id,
        side: order.side,
        price: order.price,
        stake: order.stake,
        userId: order.userId,
      });
      const persisted = (book as unknown as { orders: Map<string, Order> }).orders.get(order.id);
      if (persisted) {
        persisted.remainingStake = order.remainingStake ?? order.stake;
      }
    }
  }

  const match = book.addOrder({
    id: `incoming-${Date.now()}`,
    selectionId: incoming.selectionId,
    side: incoming.side,
    price: incoming.price,
    stake: incoming.stake,
    userId: incoming.userId,
  });

  const snapshot = book.getSnapshot(incoming.selectionId);
  return { match, snapshot };
};
