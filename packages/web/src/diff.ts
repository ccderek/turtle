/** Split a unified `git diff` into files with +/− counts. */
export interface FileDiff {
  path: string;
  status: "added" | "deleted" | "modified" | "renamed" | "binary";
  added: number;
  deleted: number;
  lines: string[];
}

export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.*)$/.exec(line);
      cur = { path: m?.[1] ?? line.slice(11), status: "modified", added: 0, deleted: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename to ")) cur.status = "renamed";
    else if (line.startsWith("Binary files")) cur.status = "binary";
    else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index "))
      continue;
    else if (
      line.startsWith("@@") ||
      cur.lines.length ||
      line.startsWith("+") ||
      line.startsWith("-") ||
      line.startsWith(" ")
    ) {
      if (line.startsWith("+")) cur.added++;
      else if (line.startsWith("-")) cur.deleted++;
      cur.lines.push(line);
    }
  }
  return files;
}
