import { extname } from "node:path";
import type { ComparedFile, ComparedValue, ReplayComparison } from "./types.js";

/**
 * Comparing a replay's results with the original's (architecture §3.7). It reports, it
 * does not judge: a replay with other parameters is expected to differ. Numbers come from
 * CSV/TSV tables: a row per label when the first column names the rows (metric,value),
 * otherwise the mean of each numeric column.
 */

const MAX_VALUES = 24;
const MAX_LABEL_ROWS = 30;
/** Columns that number the rows: their mean says nothing. */
const INDEX_COL = /^(#|n|i|id|idx|index|run|row|step|trial|seed|epoch|iter(ation)?)$/i;

function table(b: Buffer, sep: string): string[][] {
  return b
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => l.split(sep).map((c) => c.trim()));
}

const num = (s: string | undefined) => {
  if (s === undefined || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Named numbers in a table: per labelled row, or the mean of each numeric column. */
export function tableNumbers(b: Buffer, path: string): Map<string, number> | null {
  const ext = extname(path).toLowerCase();
  if (ext !== ".csv" && ext !== ".tsv") return null;
  const rows = table(b, ext === ".tsv" ? "\t" : ",");
  const [head, ...body] = rows;
  if (!head || !body.length) return null;
  const numericCols = head
    .map((_, j) => j)
    .filter(
      (j) => body.some((r) => num(r[j]) !== null) && body.every((r) => num(r[j]) !== null || !r[j]),
    );
  const out = new Map<string, number>();
  const labelled =
    !numericCols.includes(0) && body.length <= MAX_LABEL_ROWS && numericCols.length > 0;
  if (labelled) {
    for (const r of body)
      for (const j of numericCols) {
        const v = num(r[j]);
        if (v === null) continue;
        out.set(numericCols.length === 1 ? (r[0] ?? "") : `${r[0]} ${head[j]}`, v);
      }
  } else {
    for (const j of numericCols) {
      if (INDEX_COL.test(head[j] ?? "")) continue;
      const vs = body.map((r) => num(r[j])).filter((v): v is number => v !== null);
      if (vs.length) out.set(`mean ${head[j]}`, vs.reduce((a, x) => a + x, 0) / vs.length);
    }
  }
  return out;
}

/** One result file: the original's version against the replay's. */
export function compareFile(
  original: string,
  replay: string,
  a: Buffer | null,
  b: Buffer | null,
): ComparedFile {
  if (!a) return { original, replay, status: "no-original" };
  if (!b) return { original, replay, status: "no-replay" };
  const status = a.equals(b) ? "same" : "changed";
  const na = tableNumbers(a, original);
  const nb = tableNumbers(b, replay);
  const values: ComparedValue[] = [];
  if (na && nb)
    for (const [name, x] of na) {
      const y = nb.get(name);
      if (y === undefined) continue;
      values.push({
        name,
        original: x,
        replay: y,
        deltaPct: x !== 0 ? ((y - x) / Math.abs(x)) * 100 : null,
      });
      if (values.length >= MAX_VALUES) break;
    }
  return { original, replay, status, ...(values.length ? { values } : {}) };
}

const fmt = (n: number) =>
  Math.abs(n) >= 1000 || Number.isInteger(n) ? String(Math.round(n * 100) / 100) : n.toPrecision(4);
export const fmtDelta = (d: number | null) =>
  d === null ? "n/a" : `${d > 0 ? "+" : ""}${d.toFixed(Math.abs(d) < 10 ? 1 : 0)}%`;

/** The comparison as text, for an agent's prompt and the checkpoint message. */
export function comparisonText(c: ReplayComparison): string {
  const lines: string[] = [];
  for (const f of c.files) {
    const name = f.original === f.replay ? f.replay : `${f.original} → ${f.replay}`;
    if (f.status === "no-original") lines.push(`- ${name}: not in the original`);
    else if (f.status === "no-replay") lines.push(`- ${name}: not produced by the replay`);
    else if (f.status === "same") lines.push(`- ${name}: identical to the original`);
    else if (!f.values?.length) lines.push(`- ${name}: changed`);
    else {
      lines.push(`- ${name}:`);
      for (const v of f.values)
        lines.push(
          `  - ${v.name}: ${fmt(v.original)} → ${fmt(v.replay)} (${fmtDelta(v.deltaPct)})`,
        );
    }
  }
  return lines.join("\n");
}

/** A one-line summary: the largest changes. */
export function comparisonSummary(c: ReplayComparison, n = 3): string {
  const vals = c.files
    .flatMap((f) => f.values ?? [])
    .filter((v) => v.deltaPct !== null)
    .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
    .slice(0, n);
  if (vals.length)
    return vals
      .map((v) => `${v.name} ${fmt(v.original)} → ${fmt(v.replay)} (${fmtDelta(v.deltaPct)})`)
      .join("; ");
  const same = c.files.filter((f) => f.status === "same").length;
  return same === c.files.length ? "results identical to the original" : "results changed";
}
