import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ModelPrice } from "../config.js";
import {
  HeuristicSummarizer,
  type Summarizer,
  type Summary,
  type SummaryInput,
} from "./summarizer.js";
import { estimateCost, priceFor } from "./usage.js";

const SummarySchema = z.object({
  title: z
    .string()
    .describe("Commit subject: imperative, under 72 characters, no trailing period."),
  body: z
    .string()
    .describe("1-5 short lines: what changed and why. Empty if the title says it all."),
});

const SYSTEM = `You write commit messages for checkpoints of an AI coding agent's work.
Describe what the code change does, based on the diff. Use the agent's own words only when they
match the diff. Do not invent changes that are not in the diff. If nothing changed, say what the
agent was doing instead.`;

/**
 * Writes summaries for rule-based checkpoints with a small model (docs/phase0-spec.md §13).
 * Only the diff, the tool list and the last assistant text are sent, never thinking.
 */
export class AnthropicSummarizer implements Summarizer {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    private readonly prices: Record<string, ModelPrice>,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  async summarize(input: SummaryInput): Promise<Summary> {
    const tools = input.toolCalls.map((t) => `- ${t.name} ${t.input}`.trimEnd()).join("\n");
    const content = [
      `Task the human gave the agent:\n${input.intent}`,
      `Why this checkpoint: ${input.trigger}`,
      `Changed files (+${input.stat.linesAdded} -${input.stat.linesDeleted}):\n${input.changedPaths.join("\n") || "(none)"}`,
      `Tool calls since the last checkpoint:\n${tools || "(none)"}`,
      input.lastAssistantText
        ? `Agent's last message:\n${input.lastAssistantText.slice(0, 2000)}`
        : "",
      `Diff:\n${input.diff || "(empty)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(SummarySchema), effort: "low" },
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new Error(`summarizer returned no summary (stop_reason ${response.stop_reason})`);
    }
    const u = response.usage;
    const tokens = {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    };
    return {
      title: response.parsed_output.title.trim(),
      body: response.parsed_output.body.trim(),
      usage: {
        ...tokens,
        model: this.model,
        costUsd: estimateCost(tokens, priceFor(this.prices, this.model)),
      },
    };
  }
}

/** Use `primary`, falling back to `fallback` (default: heuristic) when it throws. */
export class FallbackSummarizer implements Summarizer {
  constructor(
    private readonly primary: Summarizer,
    private readonly fallback: Summarizer = new HeuristicSummarizer(),
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async summarize(input: SummaryInput): Promise<Summary> {
    try {
      return await this.primary.summarize(input);
    } catch (err) {
      this.onError(err);
      return this.fallback.summarize(input);
    }
  }
}
