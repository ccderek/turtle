import { describe, expect, it } from "vitest";
import { formatNodeMessage, parseNodeMessage } from "../src/git/message.js";
import { ID_LENGTH, isId, newId, shortestUniquePrefixes } from "../src/ids.js";

describe("ids", () => {
  it("generates readable, unique ids", () => {
    const ids = new Set(Array.from({ length: 10_000 }, newId));
    expect(ids.size).toBe(10_000);
    for (const id of [...ids].slice(0, 100)) {
      expect(id).toHaveLength(ID_LENGTH);
      expect(isId(id)).toBe(true);
      expect(id).not.toMatch(/[ilou]/);
    }
  });

  it("computes shortest unique prefixes of at least 4 chars", () => {
    const prefixes = shortestUniquePrefixes(["abcdefgh0000", "abcdexyz0000", "zz0000000000"]);
    expect(prefixes.get("abcdefgh0000")).toBe("abcdef");
    expect(prefixes.get("abcdexyz0000")).toBe("abcdex");
    expect(prefixes.get("zz0000000000")).toBe("zz00");
  });
});

describe("node messages", () => {
  it("formats title, body and trailers in a stable order", () => {
    const text = formatNodeMessage({
      title: "Fix export\nwith newline",
      body: "Details here.\n\nMore details.",
      trailers: { "Turtle-Status": "done", "Turtle-Node": "n1" },
    });
    expect(text).toBe(
      "Fix export with newline\n\nDetails here.\n\nMore details.\n\nTurtle-Node: n1\nTurtle-Status: done\n",
    );
    expect(parseNodeMessage(text)).toEqual({
      title: "Fix export with newline",
      body: "Details here.\n\nMore details.",
      trailers: { "Turtle-Node": "n1", "Turtle-Status": "done" },
    });
  });

  it("parses messages without body or trailers", () => {
    expect(parseNodeMessage("micro: after Edit\n")).toEqual({
      title: "micro: after Edit",
      trailers: {},
    });
    expect(parseNodeMessage(formatNodeMessage({ title: "", trailers: {} })).title).toBe(
      "(no summary)",
    );
  });

  it("does not mistake a body paragraph for trailers", () => {
    const parsed = parseNodeMessage("Title\n\nNote: this is prose\n");
    expect(parsed.body).toBe("Note: this is prose");
    expect(parsed.trailers).toEqual({});
  });
});
