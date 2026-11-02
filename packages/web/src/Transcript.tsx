import { Fragment } from "react";
import type { NodeView, TranscriptItem } from "./api.js";
import { firstLine, money, STATUS_LABEL, statusTone } from "./format.js";

interface Props {
  items: TranscriptItem[];
  nodes: Map<string, NodeView>;
  short: (id: string) => string;
  onSelectNode?: (id: string) => void;
  /** Show a "working" indicator at the end. */
  live?: boolean;
}

/**
 * The agent's conversation: text, collapsible tool calls (with their results), and a
 * divider after the last message of each checkpoint.
 */
export function Transcript({ items, nodes, short, onSelectNode, live }: Props) {
  const results = new Map<string, Extract<TranscriptItem, { kind: "tool_result" }>>();
  for (const it of items) if (it.kind === "tool_result") results.set(it.toolUseId, it);

  // Index of the last item attributed to each node: the checkpoint divider goes after it.
  const lastOfNode = new Map<string, number>();
  items.forEach((it, i) => {
    if (it.nodeId) lastOfNode.set(it.nodeId, i);
  });

  return (
    <div className="transcript">
      {items.map((it, i) => {
        const divider =
          it.nodeId && lastOfNode.get(it.nodeId) === i ? nodes.get(it.nodeId) : undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one message have no id; the list only grows.
          <Fragment key={`${it.agentId}-${it.seq}-${i}`}>
            <Item item={it} result={it.kind === "tool_use" ? results.get(it.id) : undefined} />
            {divider && divider.kind !== "micro" && (
              <button
                type="button"
                className={`cp-divider ${statusTone(divider.status)}`}
                onClick={() => onSelectNode?.(divider.id)}
              >
                <span className="diamond" aria-hidden="true" />
                <span className="mono">{short(divider.id)}</span>
                <span className="cp-title">{firstLine(divider.summary)}</span>
                <span className="badge">
                  {divider.summarySource === "rule_auto"
                    ? "auto"
                    : (STATUS_LABEL[divider.status] ?? divider.status)}
                </span>
              </button>
            )}
          </Fragment>
        );
      })}
      {live && (
        <div className="working">
          <span className="run-dot" /> working…
        </div>
      )}
    </div>
  );
}

function Item({
  item,
  result,
}: {
  item: TranscriptItem;
  result: Extract<TranscriptItem, { kind: "tool_result" }> | undefined;
}) {
  const sub = item.sub ? " sub" : "";
  switch (item.kind) {
    case "user":
      return <div className={`msg user${sub}`}>{item.text}</div>;
    case "text":
      return <div className={`msg assistant${sub}`}>{item.text}</div>;
    case "thinking":
      return (
        <details className={`msg thinking${sub}`}>
          <summary>Thinking</summary>
          <div className="pre">{item.text}</div>
        </details>
      );
    case "tool_use": {
      const isCheckpoint = item.name === "mcp__turtle__checkpoint";
      const state = !result ? "pending" : result.isError ? "error" : "ok";
      return (
        <details className={`tool ${state}${isCheckpoint ? " checkpoint" : ""}${sub}`}>
          <summary className="tool-head">
            <span className="tool-state" title={state} />
            <span className="tool-name">
              {isCheckpoint ? "checkpoint" : item.name.replace(/^mcp__turtle__/, "turtle.")}
            </span>
            <span className="tool-summary">{item.summary}</span>
          </summary>
          <div className="tool-body">
            <div className="label">input</div>
            <pre>{item.input}</pre>
            {result && (
              <>
                <div className="label">{result.isError ? "error" : "result"}</div>
                <pre className={result.isError ? "bad" : ""}>{result.text || "(empty)"}</pre>
              </>
            )}
          </div>
        </details>
      );
    }
    case "tool_result":
      return null; // shown inside its tool call
    case "result":
      return (
        <div className={`msg result ${item.subtype === "success" ? "ok" : "bad"}`}>
          Run ended · {item.subtype} · {money(item.costUsd)}
          {item.numTurns !== null ? ` · ${item.numTurns} turns` : ""}
        </div>
      );
    case "system":
      return <div className="msg system">{item.text}</div>;
  }
}
