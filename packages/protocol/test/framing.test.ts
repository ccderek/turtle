import { describe, expect, it } from "vitest";
import { createLineParser, encodeMessage, type FromRunner } from "../src/index.js";

describe("JSONL framing", () => {
  it("parses messages split across chunks and reports invalid lines", () => {
    const got: FromRunner[] = [];
    const invalid: string[] = [];
    const feed = createLineParser<FromRunner>(
      (m) => got.push(m),
      (l) => invalid.push(l),
    );
    const a = encodeMessage({ t: "log", level: "info", message: "héllo\nworld" });
    const b = encodeMessage({ t: "exit", code: 0 });
    const all = `${a}not json\n\n${b}`;
    feed(all.slice(0, 7));
    feed(Buffer.from(all.slice(7, 30)));
    feed(all.slice(30));
    expect(got).toEqual([
      { t: "log", level: "info", message: "héllo\nworld" },
      { t: "exit", code: 0 },
    ]);
    expect(invalid).toEqual(["not json"]);
  });

  it("keeps an incomplete trailing line until its newline arrives", () => {
    const got: unknown[] = [];
    const feed = createLineParser((m) => got.push(m));
    feed('{"t":"exit"');
    expect(got).toEqual([]);
    feed(',"code":1}\n');
    expect(got).toEqual([{ t: "exit", code: 1 }]);
  });
});
