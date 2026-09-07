import { DomainError } from "../../../shared/errors/DomainError";

export type OddsFormat = "decimal" | "american" | "fractional" | "implied";

export interface ImpliedProbabilityInput {
  /** Odds from a single bookmaker. Accepts decimal, american or fractional strings/numbers. */
  odds: Array<string | number>;
  /** Output format requested by the caller. Defaults to decimal. */
  outputFormat?: "percentage" | "decimal" | "both";
  /** Whether to perform multiplicative (Pinnacle-style) or additive (fair) vig removal. */
  vigRemovalMethod?: "multiplicative" | "additive" | "none";
  /** Optional custom margin to subtract instead of deriving from the book. 0..1 */
  customMargin?: number;
}

export interface FairOddsEntry {
  rawOdds: number;
  rawImpliedProbability: number;
  fairProbability: number;
  fairDecimalOdds: number;
  vigComponent: number;
}

export interface ImpliedProbabilityResult {
  marketOverround: number;
  vigPercentage: number;
  bookImpliedTotal: number;
  fairBookProbabilities: FairOddsEntry[];
  isArbitrageOpportunity: boolean;
  arbitrageProfitPercentage: number;
  probabilitiesPercentage: number[];
  probabilitiesDecimal: number[];
  metadata: {
    formattedAt: string;
    format: "percentage" | "decimal" | "both";
    method: "multiplicative" | "additive" | "none";
    outcomeCount: number;
  };
}

interface NormalizedOdds {
  value: number;
  raw: number;
  source: string;
}

const AMERICAN_POSITIVE_THRESHOLD = 100;
const AMERICAN_NEGATIVE_THRESHOLD = -100;

/**
 * Converts an input odds representation into a decimal implied probability.
 * Supports american (+150/-200), fractional (5/2) and decimal (2.50) formats.
 */
const toNormalizedDecimal = (raw: string | number): NormalizedOdds => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw >= 1.01 && raw <= 1000) {
      return { value: raw, raw, source: "decimal-numeric" };
    }
    if (raw >= AMERICAN_POSITIVE_THRESHOLD) {
      return { value: 1 + raw / 100, raw, source: "american-positive" };
    }
    if (raw <= AMERICAN_NEGATIVE_THRESHOLD) {
      return { value: 1 + 100 / Math.abs(raw), raw, source: "american-negative" };
    }
    throw new DomainError(
      `Numeric odds value ${raw} is outside the supported range for american or decimal interpretation`,
      "INVALID_ODDS_RANGE",
    );
  }

  if (typeof raw !== "string") {
    throw new DomainError("Odds entries must be strings or numbers", "INVALID_ODDS_TYPE");
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new DomainError("Empty odds string supplied", "EMPTY_ODDS_STRING");
  }

  // American explicit format, e.g. "+150", "-200"
  if (/^[+-]\d{2,4}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (numeric >= AMERICAN_POSITIVE_THRESHOLD) {
      return { value: 1 + numeric / 100, raw: numeric, source: "american-explicit-positive" };
    }
    return { value: 1 + 100 / Math.abs(numeric), raw: numeric, source: "american-explicit-negative" };
  }

  // Fractional format, e.g. "5/2", "11/4"
  if (/^\d+\/\d+$/.test(trimmed)) {
    const [numerator, denominator] = trimmed.split("/").map(Number);
    if (denominator === 0) {
      throw new DomainError(`Fractional odds ${trimmed} have zero denominator`, "INVALID_FRACTIONAL_ODDS");
    }
    return { value: 1 + numerator / denominator, raw: numerator / denominator, source: "fractional" };
  }

  // Decimal string, e.g. "2.75"
  const asDecimal = Number(trimmed);
  if (Number.isFinite(asDecimal) && asDecimal >= 1.01) {
    return { value: asDecimal, raw: asDecimal, source: "decimal-string" };
  }

  throw new DomainError(`Unable to parse odds entry "${trimmed}"`, "UNPARSEABLE_ODDS");
};

const applyVigRemoval = (
  rawProbabilities: number[],
  method: "multiplicative" | "additive" | "none",
  customMargin?: number,
): { fair: number[]; vig: number; total: number } => {
  const total = rawProbabilities.reduce((acc, current) => acc + current, 0);

  if (method === "none" && customMargin === undefined) {
    return {
      fair: [...rawProbabilities],
      vig: total - 1,
      total,
    };
  }

  if (customMargin !== undefined) {
    if (customMargin < 0 || customMargin >= 0.5) {
      throw new DomainError(
        `customMargin must be between 0 and 0.5 (received ${customMargin})`,
        "INVALID_CUSTOM_MARGIN",
      );
    }
    const adjusted = rawProbabilities.map((probability) => Math.max(0, probability - customMargin / rawProbabilities.length));
    const renormalized = adjusted.map((probability) => probability / adjusted.reduce((acc, current) => acc + current, 0));
    return { fair: renormalized, vig: customMargin, total };
  }

  if (method === "multiplicative") {
    const product = rawProbabilities.reduce((acc, current) => acc * current, 1);
    const denominator = rawProbabilities.reduce(
      (acc, current) => acc + product / current,
      0,
    );
    if (denominator <= 0) {
      throw new DomainError("Cannot perform multiplicative vig removal with zero denominator", "INVALID_VIG_INPUT");
    }
    const fair = rawProbabilities.map((probability) => product / (probability * denominator));
    return { fair, vig: total - 1, total };
  }

  if (method === "additive") {
    const overround = total - 1;
    if (overround <= 0) {
      throw new DomainError(
        "Additive vig removal requires an overround greater than zero (negative arb detected)",
        "NEGATIVE_OVERROUND",
      );
    }
    const fair = rawProbabilities.map((probability) => probability / total);
    return { fair, vig: overround, total };
  }

  throw new DomainError(`Unsupported vig removal method: ${method}`, "UNSUPPORTED_VIG_METHOD");
};

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Converts a set of bookmaker odds into fair implied probabilities and detects
 * whether the market contains an arbitrage opportunity. Designed to be consumed
 * directly by the trading desk and CLV pipelines within pubet.
 */
export const calculateImpliedProbability = (
  input: ImpliedProbabilityInput,
): ImpliedProbabilityResult => {
  if (!input || !Array.isArray(input.odds) || input.odds.length === 0) {
    throw new DomainError("At least one odds entry must be provided", "EMPTY_ODDS_ARRAY");
  }
  if (input.odds.length < 2) {
    throw new DomainError("Implied probability requires a minimum of 2 outcomes", "INSUFFICIENT_OUTCOMES");
  }

  const format = input.outputFormat ?? "percentage";
  const method = input.vigRemovalMethod ?? "multiplicative";

  const normalized = input.odds.map((entry) => toNormalizedDecimal(entry));
  if (normalized.some((entry) => entry.value < 1.01)) {
    throw new DomainError("All odds must imply a decimal price greater than or equal to 1.01", "INVALID_ODDS_VALUE");
  }

  const rawProbabilities = normalized.map((entry) => 1 / entry.value);
  const { fair, vig, total } = applyVigRemoval(rawProbabilities, method, input.customMargin);

  const fairBookProbabilities: FairOddsEntry[] = normalized.map((entry, index) => ({
    rawOdds: roundTo(entry.value, 4),
    rawImpliedProbability: roundTo(rawProbabilities[index], 6),
    fairProbability: roundTo(fair[index], 6),
    fairDecimalOdds: roundTo(1 / fair[index], 4),
    vigComponent: roundTo(rawProbabilities[index] - fair[index], 6),
  }));

  const arbitrageProfitPercentage = roundTo(Math.max(0, (1 - total) * 100), 4);
  const isArbitrageOpportunity = total < 1;

  const probabilitiesPercentage = fairBookProbabilities.map((entry) => roundTo(entry.fairProbability * 100, 4));
  const probabilitiesDecimal = fairBookProbabilities.map((entry) => roundTo(entry.fairProbability, 6));

  return {
    marketOverround: roundTo(total, 6),
    vigPercentage: roundTo(vig * 100, 4),
    bookImpliedTotal: roundTo(total, 6),
    fairBookProbabilities,
    isArbitrageOpportunity,
    arbitrageProfitPercentage,
    probabilitiesPercentage,
    probabilitiesDecimal,
    metadata: {
      formattedAt: new Date().toISOString(),
      format,
      method,
      outcomeCount: normalized.length,
    },
  };
};

export default calculateImpliedProbability;
