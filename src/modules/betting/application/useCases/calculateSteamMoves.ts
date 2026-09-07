import { validateInput } from "./validateBet";

export type OddsTick = {
  eventId: string;
  marketId: string;
  selectionId: string;
  price: number;
  volume: number;
  timestamp: number; // epoch ms
};

export type SteamMove = {
  eventId: string;
  marketId: string;
  selectionId: string;
  direction: "UP" | "DOWN";
  magnitude: number; // absolute price delta in ticks
  priceBefore: number;
  priceAfter: number;
  volumeBefore: number;
  volumeAfter: number;
  volumeSpikeRatio: number; // volumeAfter / max(1, avgVolumeBefore)
  windowMs: number;
  sharpScore: number; // 0..100
  detectedAt: number;
};

export type SteamMoveConfig = {
  windowMs: number; // analysis window
  minTickDelta: number; // minimum number of price ticks movement to qualify
  tickSize: number; // size of one tick (e.g., 0.01 for decimal odds)
  minVolumeSpike: number; // minimum multiplier vs rolling avg to qualify as steam
  minSharpScore: number; // output filter
};

export const DEFAULT_STEAM_CONFIG: SteamMoveConfig = {
  windowMs: 60_000,
  minTickDelta: 3,
  tickSize: 0.01,
  minVolumeSpike: 2.5,
  minSharpScore: 60,
};

type SelectionState = {
  selectionId: string;
  marketId: string;
  ticks: OddsTick[];
};

function groupTicks(ticks: OddsTick[]): Map<string, SelectionState> {
  const grouped = new Map<string, SelectionState>();
  for (const tick of ticks) {
    const key = `${tick.eventId}::${tick.marketId}::${tick.selectionId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.ticks.push(tick);
    } else {
      grouped.set(key, {
        selectionId: tick.selectionId,
        marketId: tick.marketId,
        ticks: [tick],
      });
    }
  }
  for (const state of grouped.values()) {
    state.ticks.sort((a, b) => a.timestamp - b.timestamp);
  }
  return grouped;
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function computeSharpScore(args: {
  tickDelta: number;
  volumeSpikeRatio: number;
  windowMs: number;
  tickCount: number;
}): number {
  const { tickDelta, volumeSpikeRatio, windowMs, tickCount } = args;
  const density = tickCount / Math.max(1, windowMs / 1000);
  const speedFactor = clamp(density / 5, 0, 1); // saturates at 5 ticks/sec
  const sizeFactor = clamp((volumeSpikeRatio - 1) / 5, 0, 1); // saturates at 6x
  const deltaFactor = clamp(tickDelta / 10, 0, 1); // saturates at 10 ticks
  const composite = (speedFactor * 0.4 + sizeFactor * 0.4 + deltaFactor * 0.2) * 100;
  return Math.round(clamp(composite, 0, 100));
}

function detectForSelection(
  state: SelectionState,
  eventId: string,
  config: SteamMoveConfig,
  now: number,
): SteamMove | null {
  const windowStart = now - config.windowMs;
  const inWindow = state.ticks.filter(
    (t) => t.timestamp >= windowStart && t.timestamp <= now,
  );
  if (inWindow.length < 2) return null;

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const priceDelta = last.price - first.price;
  const tickDelta = priceDelta / config.tickSize;
  const absTickDelta = Math.abs(tickDelta);

  if (absTickDelta < config.minTickDelta) return null;

  const volumes = inWindow.map((t) => t.volume);
  const avgVolume = average(volumes.slice(0, Math.max(1, volumes.length - 1)));
  const lastVolume = last.volume;
  const volumeSpikeRatio = lastVolume / Math.max(1e-6, avgVolume);

  if (volumeSpikeRatio < config.minVolumeSpike) return null;

  const sharpScore = computeSharpScore({
    tickDelta: absTickDelta,
    volumeSpikeRatio,
    windowMs: config.windowMs,
    tickCount: inWindow.length,
  });

  if (sharpScore < config.minSharpScore) return null;

  return {
    eventId,
    marketId: state.marketId,
    selectionId: state.selectionId,
    direction: priceDelta > 0 ? "UP" : "DOWN",
    magnitude: Number(absTickDelta.toFixed(2)),
    priceBefore: first.price,
    priceAfter: last.price,
    volumeBefore: Number(avgVolume.toFixed(2)),
    volumeAfter: Number(lastVolume.toFixed(2)),
    volumeSpikeRatio: Number(volumeSpikeRatio.toFixed(2)),
    windowMs: config.windowMs,
    sharpScore,
    detectedAt: now,
  };
}

export type CalculateSteamMovesInput = {
  ticks: OddsTick[];
  config?: Partial<SteamMoveConfig>;
  asOf?: number;
};

export type CalculateSteamMovesOutput = {
  moves: SteamMove[];
  analyzedAt: number;
  configUsed: SteamMoveConfig;
  totalSelectionsScanned: number;
};

export function calculateSteamMoves(
  input: CalculateSteamMovesInput,
): CalculateSteamMovesOutput {
  validateInput(input, ["ticks"]);
  if (!Array.isArray(input.ticks)) {
    throw new TypeError("ticks must be an array of OddsTick");
  }

  const config: SteamMoveConfig = {
    ...DEFAULT_STEAM_CONFIG,
    ...(input.config ?? {}),
  };

  if (config.tickSize <= 0) {
    throw new RangeError("tickSize must be > 0");
  }
  if (config.windowMs <= 0) {
    throw new RangeError("windowMs must be > 0");
  }
  if (config.minTickDelta < 0) {
    throw new RangeError("minTickDelta must be >= 0");
  }

  const now =
    typeof input.asOf === "number" && Number.isFinite(input.asOf)
      ? input.asOf
      : Date.now();

  const grouped = groupTicks(input.ticks);
  const moves: SteamMove[] = [];

  for (const [key, state] of grouped) {
    const [eventId, ,] = key.split("::");
    const move = detectForSelection(state, eventId, config, now);
    if (move) moves.push(move);
  }

  moves.sort((a, b) => b.sharpScore - a.sharpScore || b.detectedAt - a.detectedAt);

  return {
    moves,
    analyzedAt: now,
    configUsed: config,
    totalSelectionsScanned: grouped.size,
  };
}

export default calculateSteamMoves;
