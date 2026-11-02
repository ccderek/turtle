import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { AnthropicSummarizer, FallbackSummarizer } from "../src/run/anthropic-summarizer.js";
import { HeuristicSummarizer, type SummaryInput } from "../src/run/summarizer.js";

const input: SummaryInput = {
  intent: "Add a --json flag",
  trigger: "rule:maxToolCalls",
  stat: { filesChanged: 2, linesAdded: 10, linesDeleted: 1 },
  changedPaths: ["src/export.ts", "src/cli.ts"],
  diff: "+json",
  toolCalls: [{ name: "Edit", input: "src/export.ts" }],
  lastAssistantText: "Wiring the flag.",
};

function fakeClient(response: unknown, seen: unknown[] = []) {
  return {
    messages: {
      parse: async (params: unknown) => {
        seen.push(params);
        return response;
      },
    },
  } as never;
}

describe("AnthropicSummarizer", () => {
  it("sends the diff context with low effort and returns title, body and cost", async () => {
    const seen: Record<string, unknown>[] = [];
    const s = new AnthropicSummarizer(
      "claude-haiku-5-5",
      DEFAULT_CONFIG.prices,
      fakeClient(
        {
          stop_reason: "end_turn",
          parsed_output: {
            title: " Add --json flag to export ",
            body: "Prints JSON when --json is set.\n",
          },
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
          },
        },
        seen,
      ),
    );
    const out = await s.summarize(input);
    expect(out.title).toBe("Add --json flag to export");
    expect(out.body).toBe("Prints JSON when --json is set.");
    expect(out.usage).toMatchObject({
      model: "claude-haiku-5-5",
      input: 1000,
      output: 50,
      cacheRead: 0,
    });
    expect(out.usage?.costUsd).toBeCloseTo((1000 * 0.1 + 50 * 0.5) / 1e6);
    const params = seen[0] as {
      model: string;
      output_config: { effort: string };
      messages: { content: string }[];
    };
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.output_config.effort).toBe("low");
    expect(params.messages[0]?.content).toContain("src/export.ts");
    expect(params.messages[0]?.content).toContain("Why this checkpoint: rule:maxToolCalls");
  });

  it("throws on refusal so the fallback can take over", async () => {
    const primary = new AnthropicSummarizer(
      "claude-haiku-5-5",
      DEFAULT_CONFIG.prices,
      fakeClient({
        stop_reason: "refusal",
        parsed_output: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    );
    await expect(primary.summarize(input)).rejects.toThrow(/refusal/);
    const errors: unknown[] = [];
    const out = await new FallbackSummarizer(primary, new HeuristicSummarizer(), (e) =>
      errors.push(e),
    ).summarize(input);
    expect(out.title).toBe("Change src/export.ts, src/cli.ts (+10 −1)");
    expect(errors).toHaveLength(1);
  });
});
