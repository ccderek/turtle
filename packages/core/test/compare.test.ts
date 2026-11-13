import { describe, expect, it } from "vitest";
import {
  compareFile,
  comparisonSummary,
  comparisonText,
  tableNumbers,
} from "../src/project/compare.js";

const b = (s: string) => Buffer.from(s);

describe("comparing a replay's results with the original's", () => {
  it("reads labelled rows and column means from tables", () => {
    expect(
      Object.fromEntries(tableNumbers(b("metric,value\nsharpe,1.2\nreturn,0.18\n"), "r.csv") ?? []),
    ).toEqual({ sharpe: 1.2, return: 0.18 });
    expect(
      Object.fromEntries(tableNumbers(b("run,power_mw,fps\n1,800,40\n2,810,42\n"), "p.csv") ?? []),
    ).toEqual({ "mean power_mw": 805, "mean fps": 41 });
    expect(tableNumbers(b("x"), "a.txt")).toBeNull();
  });

  it("reports changes in percent, and says when files are identical or missing", () => {
    const f = compareFile(
      "results/power-A.csv",
      "results/power-B.csv",
      b("run,power_mw\n1,800\n2,810\n"),
      b("run,power_mw\n1,640\n2,648\n"),
    );
    expect(f.status).toBe("changed");
    const power = f.values?.find((v) => v.name === "mean power_mw");
    expect(power?.original).toBe(805);
    expect(power?.deltaPct).toBeCloseTo(-20, 0);
    const c = {
      against: "n1",
      files: [
        f,
        compareFile("a.txt", "a.txt", b("x"), b("x")),
        compareFile("n.csv", "n.csv", null, b("x")),
      ],
    };
    const text = comparisonText(c);
    expect(text).toContain("results/power-A.csv → results/power-B.csv:");
    expect(text).toContain("mean power_mw: 805 → 644 (-20%)");
    expect(text).toContain("a.txt: identical to the original");
    expect(text).toContain("n.csv: not in the original");
    expect(comparisonSummary(c, 1)).toBe("mean power_mw 805 → 644 (-20%)");
  });
});
