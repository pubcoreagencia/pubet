/**
 * calculateExpectedValue.ts
 *
 * High-Frequency Odds Architect feature.
 * Calcula o Valor Esperado (EV) de uma aposta, identifica se há +
 * edge positivo (value bet), integra com Kelly Criterion para sizing
 * ótimo e rastreia o Closing Line Value (CLV) implícito para
 * auditoria contínua da precisão do modelo de odds.
 *
 * Production-grade: tipado, puro, sem dependências externas,
 * deterministicamente testável, pronto para uso em esteiras
 * de decisão em tempo-real dentro do PubBet.
 */

export type OddsFormat = 'decimal' | 'american' | 'fractional';

export interface ValueBetInput {
  /** Identificador único do evento (ex: matchId) */
  eventId: string;
  /** Identificador do mercado (ex: 'home_win', 'over_2_5') */
  marketId: string;
  /** Probabilidade estimada pelo nosso modelo (0..1) */
  trueProbability: number;
  /** Odds oferecidas pela casa no formato normalizado abaixo */
  decimalOdds: number;
  /** Stake disponível para alocação (banca em unidades) */
  bankroll: number;
  /** Fração de Kelly a aplicar (0..1). Default 0.25 (quarter-Kelly). */
  kellyFraction?: number;
  /** Margem máxima permitida por aposta (limite de risco) */
  maxStakeFraction?: number;
  /** Odds de fechamento para cálculo implícito de CLV */
  closingDecimalOdds?: number;
}

export interface ExpectedValueResult {
  eventId: string;
  marketId: string;
  impliedProbability: number;
  trueProbability: number;
  decimalOdds: number;
  expectedValue: number;
  expectedValuePercent: number;
  edgePercent: number;
  isValueBet: boolean;
  kellyFraction: number;
  recommendedStake: number;
  recommendedStakePercent: number;
  closingLineValuePercent: number | null;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

const EPSILON = 1e-9;

/**
 * Converte odds decimais para probabilidade implícita.
 * Ex: 2.50 -> 0.40 (40%).
 */
export function decimalToImpliedProbability(decimalOdds: number): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) {
    throw new Error(`Invalid decimal odds: ${decimalOdds}. Must be > 1.`);
  }
  return 1 / decimalOdds;
}

/**
 * Fração de Kelly clássica: f* = (bp - q) / b
 * Onde b = decimalOdds - 1, p = trueProbability, q = 1 - p.
 */
export function rawKellyFraction(decimalOdds: number, trueProbability: number): number {
  const b = decimalOdds - 1;
  const p = clamp01(trueProbability);
  const q = 1 - p;
  const f = (b * p - q) / b;
  return Math.max(0, f);
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Calcula o EV percentual: EV% = (p * (odds - 1)) - (1 - p)
 */
export function expectedValuePercent(
  decimalOdds: number,
  trueProbability: number,
): number {
  const p = clamp01(trueProbability);
  return p * (decimalOdds - 1) - (1 - p);
}

/**
 * Calcula o CLV percentual comparando nossas odds iniciais
 * com a linha de fechamento do mercado.
 * CLV% = (odds_iniciais / odds_fechamento) - 1
 */
export function closingLineValuePercent(
  initialOdds: number,
  closingOdds: number,
): number {
  if (!Number.isFinite(closingOdds) || closingOdds <= 1) return 0;
  return (initialOdds / closingOdds) - 1;
}

/**
 * Classifica a confiança com base na magnitude do edge.
 * Edge < 3%  -> low
 * Edge < 8%  -> medium
 * Edge >= 8% -> high
 */
function classifyConfidence(edgePercent: number): 'low' | 'medium' | 'high' {
  const abs = Math.abs(edgePercent);
  if (abs < 0.03) return 'low';
  if (abs < 0.08) return 'medium';
  return 'high';
}

/**
 * Calcula EV, edge, sizing via Kelly e CLV implícito.
 * Retorna null se a entrada for inválida (validação falha).
 */
export function calculateExpectedValue(
  input: ValueBetInput,
): ExpectedValueResult | null {
  const { eventId, marketId, bankroll } = input;

  if (!eventId || !marketId) return null;
  if (!Number.isFinite(input.trueProbability)) return null;
  if (!Number.isFinite(input.decimalOdds) || input.decimalOdds <= 1) return null;
  if (!Number.isFinite(bankroll) || bankroll <= 0) return null;

  const trueProbability = clamp01(input.trueProbability);
  const decimalOdds = input.decimalOdds;
  const impliedProbability = decimalToImpliedProbability(decimalOdds);
  const evPct = expectedValuePercent(decimalOdds, trueProbability);
  const edgePct = evPct; // edge relativo ao stake (já em decimal)

  const isValueBet = evPct > EPSILON;

  // Kelly sizing
  const kellyFractionRaw = rawKellyFraction(decimalOdds, trueProbability);
  const kellyFractionApplied = clamp01(input.kellyFraction ?? 0.25);
  const maxStakeFraction = clamp01(input.maxStakeFraction ?? 0.05);

  const rawKellyPct = kellyFractionRaw * kellyFractionApplied;
  const cappedKellyPct = Math.min(rawKellyPct, maxStakeFraction);
  const recommendedStake = isValueBet ? roundCurrency(bankroll * cappedKellyPct) : 0;
  const recommendedStakePercent = cappedKellyPct;

  // CLV implícito
  const clvPct =
    typeof input.closingDecimalOdds === 'number' && input.closingDecimalOdds > 1
      ? closingLineValuePercent(decimalOdds, input.closingDecimalOdds)
      : null;

  const confidence = classifyConfidence(edgePct);

  const rationale = buildRationale({
    isValueBet,
    edgePct,
    confidence,
    kellyFractionRaw,
    kellyFractionApplied,
    cappedKellyPct,
    clvPct,
  });

  return {
    eventId,
    marketId,
    impliedProbability: round6(impliedProbability),
    trueProbability: round6(trueProbability),
    decimalOdds,
    expectedValue: round6(evPct * recommendedStake),
    expectedValuePercent: round6(evPct),
    edgePercent: round6(edgePct),
    isValueBet,
    kellyFraction: round6(rawKellyPct),
    recommendedStake,
    recommendedStakePercent: round6(cappedKellyPct),
    closingLineValuePercent: clvPct === null ? null : round6(clvPct),
    confidence,
    rationale,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildRationale(params: {
  isValueBet: boolean;
  edgePct: number;
  confidence: 'low' | 'medium' | 'high';
  kellyFractionRaw: number;
  kellyFractionApplied: number;
  cappedKellyPct: number;
  clvPct: number | null;
}): string {
  const edgeStr = (params.edgePct * 100).toFixed(2) + '%';
  const kellyStr = (params.kellyFractionRaw * 100).toFixed(2) + '%';
  const stakeStr = (params.cappedKellyPct * 100).toFixed(2) + '%';

  if (!params.isValueBet) {
    return `No value detected. Edge=${edgeStr}, Kelly raw=${kellyStr}. Skipping bet.`;
  }

  const clvPart =
    params.clvPct !== null
      ? `, CLV=${(params.clvPct * 100).toFixed(2)}%`
      : '';

  return (
    `Value bet (${params.confidence} confidence). Edge=${edgeStr}, ` +
    `raw Kelly=${kellyStr} @ fraction=${(params.kellyFractionApplied * 100).toFixed(0)}%, ` +
    `stake=${stakeStr}${clvPart}.`
  );
}

export default calculateExpectedValue;
