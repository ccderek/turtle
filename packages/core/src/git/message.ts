/**
 * Commit messages for turtle nodes. The trailers carry enough to rebuild a node's
 * DB row from git alone (see docs/phase0-spec.md §6.2, §6.6).
 */

export const TRAILER_KEYS = [
  "Turtle-Node",
  "Turtle-Kind",
  "Turtle-Status",
  "Turtle-Branch",
  "Turtle-Agent",
  "Turtle-Summary-Source",
  "Turtle-Trigger",
  /** Multi-source runs: the primary node this companion snapshot belongs to. */
  "Turtle-Checkpoint",
] as const;

export type TrailerKey = (typeof TRAILER_KEYS)[number];
export type Trailers = Partial<Record<TrailerKey, string>>;

export interface NodeMessage {
  title: string;
  body?: string;
  trailers: Trailers;
}

export function formatNodeMessage(msg: NodeMessage): string {
  const title = singleLine(msg.title) || "(no summary)";
  const parts = [title];
  const body = msg.body?.trim();
  if (body) parts.push(body);
  const trailerLines = TRAILER_KEYS.flatMap((key) => {
    const value = msg.trailers[key];
    return value === undefined ? [] : [`${key}: ${singleLine(value)}`];
  });
  if (trailerLines.length > 0) parts.push(trailerLines.join("\n"));
  return `${parts.join("\n\n")}\n`;
}

export function parseNodeMessage(raw: string): NodeMessage {
  const paragraphs = raw
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/);
  const trailers: Trailers = {};
  const last = paragraphs[paragraphs.length - 1];
  if (paragraphs.length > 1 && last !== undefined && isTrailerBlock(last)) {
    paragraphs.pop();
    for (const line of last.split("\n")) {
      const idx = line.indexOf(":");
      const key = line.slice(0, idx).trim() as TrailerKey;
      if ((TRAILER_KEYS as readonly string[]).includes(key)) {
        trailers[key] = line.slice(idx + 1).trim();
      }
    }
  }
  const [first = "", ...rest] = paragraphs;
  const [title = "", ...titleRest] = first.split("\n");
  const body = [titleRest.join("\n"), ...rest].filter((p) => p.trim() !== "").join("\n\n");
  return body ? { title, body, trailers } : { title, trailers };
}

function isTrailerBlock(paragraph: string): boolean {
  return paragraph.split("\n").every((line) => /^Turtle-[A-Za-z-]+: /.test(line));
}

function singleLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}
