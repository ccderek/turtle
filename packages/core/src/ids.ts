import { randomBytes } from "node:crypto";

/** Lowercase Crockford-style base32 (no i, l, o, u) so ids are easy to read and type. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Length of generated ids: 12 chars × 5 bits = 60 bits of randomness. */
export const ID_LENGTH = 12;

/** Shortest prefix ever shown to humans. */
export const MIN_PREFIX = 4;

/** Generate a stable, random id (nodes, branches, agents, events). */
export function newId(): string {
  const bytes = randomBytes(ID_LENGTH);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export function isId(value: string): boolean {
  return value.length === ID_LENGTH && [...value].every((c) => ALPHABET.includes(c));
}

/**
 * Shortest unique prefix (at least MIN_PREFIX chars) for each id in `ids`,
 * the way jj displays change ids.
 */
export function shortestUniquePrefixes(ids: readonly string[]): Map<string, string> {
  const sorted = [...new Set(ids)].sort();
  const result = new Map<string, string>();
  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i] as string;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const common = Math.max(
      prev ? commonPrefixLength(id, prev) : 0,
      next ? commonPrefixLength(id, next) : 0,
    );
    result.set(id, id.slice(0, Math.max(MIN_PREFIX, common + 1)));
  }
  return result;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
