import { useMemo, useState } from "react";
import { type FileDiff, parseDiff } from "./diff.js";

const MAX_LINES = 1500;

export function DiffView({ diff, truncated }: { diff: string; truncated: boolean }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  if (!files.length) return <p className="muted pad">No file changes.</p>;
  const big = files.reduce((s, f) => s + f.lines.length, 0) > 600;
  return (
    <div className="diff">
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.path}>
            <a
              href={`#diff-${encodeURIComponent(f.path)}`}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(`diff-${f.path}`)
                  ?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
            >
              <span className={`fstatus ${f.status}`}>{f.status[0]?.toUpperCase()}</span> {f.path}
            </a>
            <span className="add">+{f.added}</span> <span className="del">−{f.deleted}</span>
          </li>
        ))}
      </ul>
      {files.map((f, i) => (
        <FileBlock key={f.path} file={f} open={!big || i < 3} />
      ))}
      {truncated && <p className="muted small pad">Diff truncated (too large to show).</p>}
    </div>
  );
}

function FileBlock({ file, open }: { file: FileDiff; open: boolean }) {
  const [all, setAll] = useState(false);
  const lines = all ? file.lines : file.lines.slice(0, MAX_LINES);
  let oldNo = 0;
  let newNo = 0;
  return (
    <details className="file" open={open} id={`diff-${file.path}`}>
      <summary className="file-head">
        <span className="mono">{file.path}</span>
        <span className="add">+{file.added}</span>
        <span className="del">−{file.deleted}</span>
      </summary>
      <table className="hunk">
        <tbody>
          {lines.map((l, i) => {
            let cls = "ctx";
            let a: number | "" = "";
            let b: number | "" = "";
            if (l.startsWith("@@")) {
              const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
              oldNo = Number(m?.[1] ?? 0);
              newNo = Number(m?.[2] ?? 0);
              cls = "hh";
            } else if (l.startsWith("+")) {
              cls = "add";
              b = newNo++;
            } else if (l.startsWith("-")) {
              cls = "del";
              a = oldNo++;
            } else if (l.startsWith("\\")) {
              cls = "hh";
            } else {
              a = oldNo++;
              b = newNo++;
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no identity.
              <tr key={i} className={cls}>
                <td className="ln">{a}</td>
                <td className="ln">{b}</td>
                <td className="code">{l}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!all && file.lines.length > MAX_LINES && (
        <button type="button" className="link small pad" onClick={() => setAll(true)}>
          Show all {file.lines.length} lines
        </button>
      )}
    </details>
  );
}
