/**
 * Cost model: is it cheaper to prune the session with Jev or to keep the
 * context as it is?
 *
 * Prices are relative to the base input price `P`. A read of cached input costs
 * `cacheReadMultiplier · P` (0.1 on the Anthropic API). A write to the cache
 * costs `cacheWriteMultiplier · P` (1.25 for the 5-minute TTL, 2 for 1 hour).
 *
 * Over the next `N` turns, with a context of `C` tokens that pruning cuts to
 * `r · C` tokens:
 *
 * - Keep: the first turn reads `C` (or writes `C` when the cache expired);
 *   each of the other `N - 1` turns reads `C`.
 * - Prune: Jev costs `J` once; the first turn after the prune writes `r · C`
 *   (a new prefix is a cache miss); each of the other `N - 1` turns reads `r · C`.
 *
 * New tokens and output tokens cost the same in both cases, so context growth
 * cancels out. Tokens that the prune cannot remove (system prompt, tools) are
 * not modeled: they make the real `r` a little higher than the history's `r`.
 */

export interface CostConfig {
  /** Base input price, US dollars per 1M tokens. */
  inputPricePerMTok: number;
  /** Price of a cache read, as a multiple of the base input price. */
  cacheReadMultiplier: number;
  /** Price of a cache write, as a multiple of the base input price. */
  cacheWriteMultiplier: number;
  /** How long the prompt cache lives without a request, in minutes. */
  cacheTtlMinutes: number;
  /** Estimated price of one Jev pruning run, in US dollars. */
  jevCostUsd: number;
  /** Turns that the user is expected to do in this session after now. */
  expectedTurns: number;
  /** Fraction of the context that a prune keeps, until one was measured. */
  assumedKeepRatio: number;
  /** The automatic trigger needs at least this saving, in US dollars. */
  minSavingUsd: number;
}

export const COST_DEFAULTS: CostConfig = {
  inputPricePerMTok: 3,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
  cacheTtlMinutes: 5,
  jevCostUsd: 0.01,
  expectedTurns: 10,
  assumedKeepRatio: 0.4,
  minSavingUsd: 0.02,
};

export interface CostInput extends CostConfig {
  /** Tokens of the current context. */
  contextTokens: number;
  /** Fraction of the context that the prune keeps, 0 to 1. */
  keepRatio: number;
  /** True when the cache expired: the next turn writes the whole context. */
  cacheCold: boolean;
  /** A prune that removes less than this fraction is not worth it. */
  minReductionRatio: number;
}

export type CostVerdict = 'compact' | 'keep';

export interface CostEstimate {
  verdict: CostVerdict;
  /** One sentence that gives the reason for the verdict. */
  reason: string;
  /** US dollars of input over the next `expectedTurns` turns if nothing changes. */
  keepUsd: number;
  /** US dollars over the same turns if the session is pruned now. */
  pruneUsd: number;
  /** The Jev part of `pruneUsd`. */
  jevUsd: number;
  /** The cache-write part of `pruneUsd`. */
  writeUsd: number;
  /** The cache-read part of `pruneUsd`. */
  readUsd: number;
  /** `keepUsd - pruneUsd`; negative when pruning costs more. */
  savingUsd: number;
  /** Fewest turns after which pruning is cheaper; null when it never is. */
  breakEvenTurns: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Fewest turns after which pruning is cheaper, or null when it never is. */
export function breakEvenTurns(input: CostInput): number | null {
  const keep = clamp(input.keepRatio, 0, 1);
  if (keep >= 1) return null;
  const price = input.inputPricePerMTok / 1_000_000;
  const full = input.contextTokens * price;
  const first = (input.cacheCold ? input.cacheWriteMultiplier : input.cacheReadMultiplier) * full;
  const perTurnSaving = input.cacheReadMultiplier * full * (1 - keep);
  if (perTurnSaving <= 0) return null;
  const upfront = input.jevCostUsd + input.cacheWriteMultiplier * keep * full - first;
  return Math.max(1, Math.ceil(1 + upfront / perTurnSaving));
}

export function estimateCost(input: CostInput): CostEstimate {
  const keep = clamp(input.keepRatio, 0, 1);
  const turns = Math.max(1, input.expectedTurns);
  const price = input.inputPricePerMTok / 1_000_000;
  const full = input.contextTokens * price;
  const pruned = keep * full;
  const firstKeep = (input.cacheCold ? input.cacheWriteMultiplier : input.cacheReadMultiplier) * full;
  const keepUsd = firstKeep + (turns - 1) * input.cacheReadMultiplier * full;
  const jevUsd = input.jevCostUsd;
  const writeUsd = input.cacheWriteMultiplier * pruned;
  const readUsd = (turns - 1) * input.cacheReadMultiplier * pruned;
  const pruneUsd = jevUsd + writeUsd + readUsd;
  const savingUsd = keepUsd - pruneUsd;
  const breakEven = breakEvenTurns(input);

  let verdict: CostVerdict = 'keep';
  let reason: string;
  if (1 - keep < input.minReductionRatio) {
    reason = `The prune would remove only ${Math.round((1 - keep) * 100)}% of the context. The minimum is ${Math.round(input.minReductionRatio * 100)}%.`;
  } else if (savingUsd <= 0) {
    reason = `Pruning costs more over ${turnsText(turns)}. ${payback(breakEven)}`;
  } else if (savingUsd < input.minSavingUsd) {
    reason = `The saving is below the minimum of ${usd(input.minSavingUsd)}.`;
  } else {
    verdict = 'compact';
    reason = `Pruning saves ${usd(savingUsd)} over ${turnsText(turns)}. ${payback(breakEven)}`;
  }
  return { verdict, reason, keepUsd, pruneUsd, jevUsd, writeUsd, readUsd, savingUsd, breakEvenTurns: breakEven };
}

function turnsText(turns: number): string {
  return turns === 1 ? '1 turn' : `${turns} turns`;
}

function payback(breakEven: number | null): string {
  return breakEven === null ? 'It never pays back.' : `It pays back after ${turnsText(breakEven)}.`;
}

/** US dollars with enough digits for amounts of a few cents. */
export function usd(value: number): string {
  const sign = value < 0 ? '-' : '';
  const amount = Math.abs(value);
  return `${sign}$${amount < 0.1 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

export interface CostReportContext {
  windowTokens?: number;
  percent?: number;
  /** Where `keepRatio` came from: `assumed`, `measured` or `given`. */
  keepRatioSource: string;
  /** Minutes since the last turn ended; undefined when unknown. */
  idleMinutes?: number;
}

/** The lines of the `/jev-cost` answer. */
export function formatCostReport(
  input: CostInput,
  estimate: CostEstimate,
  context: CostReportContext,
): string[] {
  const tokens = Math.round(input.contextTokens).toLocaleString('en-US');
  const where =
    context.windowTokens !== undefined && context.percent !== undefined
      ? ` (${context.percent}% of ${context.windowTokens.toLocaleString('en-US')})`
      : '';
  const idle = context.idleMinutes === undefined ? '' : ` Idle for ${context.idleMinutes.toFixed(1)} min.`;
  const cache = input.cacheCold
    ? `Cache: expired (TTL ${input.cacheTtlMinutes} min).${idle} The next turn writes the whole context.`
    : `Cache: warm (TTL ${input.cacheTtlMinutes} min).${idle}`;
  return [
    'fast-jev-compaction cost check',
    `Context: ${tokens} tokens${where}.`,
    cache,
    `Prune keeps ${Math.round(input.keepRatio * 100)}% of the context (${context.keepRatioSource}).`,
    `Expected turns: ${input.expectedTurns}. Base input price: $${input.inputPricePerMTok}/1M tokens.`,
    `Keep context: ${usd(estimate.keepUsd)}`,
    `Prune now:    ${usd(estimate.pruneUsd)} (Jev ${usd(estimate.jevUsd)} + cache write ${usd(estimate.writeUsd)} + cache reads ${usd(estimate.readUsd)})`,
    `Saving:       ${usd(estimate.savingUsd)}`,
    `Break-even:   ${estimate.breakEvenTurns === null ? 'never' : turnsText(estimate.breakEvenTurns)}`,
    `Verdict: ${estimate.verdict === 'compact' ? 'COMPACT' : 'DO NOT COMPACT'}. ${estimate.reason}`,
  ];
}
