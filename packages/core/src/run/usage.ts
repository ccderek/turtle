import type { ModelPrice } from "../config.js";
import { type TokenUsage, ZERO_TOKENS } from "../db/types.js";

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Accumulates token usage from SDK assistant messages between nodes. The SDK can emit
 * several assistant messages for one API response (one per content block) that repeat
 * the same usage, so usage is keyed by API message id and merged with max().
 */
export class UsageTracker {
  private readonly pending = new Map<string, { usage: TokenUsage; model: string | null }>();

  constructor(private readonly prices: Record<string, ModelPrice>) {}

  add(messageId: string, usage: ApiUsage | undefined, model: string | null): void {
    if (!usage) return;
    const next: TokenUsage = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
    const prev = this.pending.get(messageId);
    if (prev) {
      prev.usage = {
        input: Math.max(prev.usage.input, next.input),
        output: Math.max(prev.usage.output, next.output),
        cacheRead: Math.max(prev.usage.cacheRead, next.cacheRead),
        cacheWrite: Math.max(prev.usage.cacheWrite, next.cacheWrite),
      };
    } else {
      this.pending.set(messageId, { usage: next, model });
    }
  }

  /** Total since the last drain, with an estimated cost; resets the tracker. */
  drain(): { tokens: TokenUsage; costUsd: number } {
    const tokens = { ...ZERO_TOKENS };
    let costUsd = 0;
    for (const { usage, model } of this.pending.values()) {
      tokens.input += usage.input;
      tokens.output += usage.output;
      tokens.cacheRead += usage.cacheRead;
      tokens.cacheWrite += usage.cacheWrite;
      costUsd += estimateCost(usage, priceFor(this.prices, model));
    }
    this.pending.clear();
    return { tokens, costUsd };
  }
}

export function priceFor(
  prices: Record<string, ModelPrice>,
  model: string | null,
): ModelPrice | null {
  if (!model) return null;
  if (prices[model]) return prices[model];
  const key = Object.keys(prices).find((k) => model.startsWith(k));
  return key ? (prices[key] ?? null) : null;
}

export function estimateCost(usage: TokenUsage, price: ModelPrice | null): number {
  if (!price) return 0;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * cacheRead +
      usage.cacheWrite * cacheWrite) /
    1_000_000
  );
}
