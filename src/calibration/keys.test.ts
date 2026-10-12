import { describe, it, expect } from "vitest";
import { matchesKeys, normalizeForKeys, missingMustSurvive } from "./review.js";
import { goldenProbes } from "./golden-set.js";
import { LARGE_GROUND_TRUTH } from "./large-probe.js";

/* ADR-0012: non-exact must-survive items are checked by their key facts, not by the whole sentence. */

const SETS = [...goldenProbes().map((g) => [g.label, g.groundTruth] as const), ["large", LARGE_GROUND_TRUTH] as const];
const ITEMS = SETS.flatMap(([label, gt]) => gt.mustSurvive.filter((i) => !i.exact).map((i) => [`${label}/${i.id}`, i] as const));

describe("key facts of the ground truths", () => {
  it("every non-exact item has keys (5 golden probes + the high-fill probe: 89 items)", () => {
    expect(ITEMS).toHaveLength(89);
    for (const [, it] of ITEMS) expect(it.keys?.length).toBeGreaterThan(0);
  });

  it.each(ITEMS)("%s: its own text carries its keys", (_, it) => {
    expect(matchesKeys(it.text, it.keys!)).toBe(true);
  });

  it("a brief skeleton (bucket headings only) carries no item", () => {
    const skeleton = "1) DECISIONS\n2) EVIDENCE\n3) OPEN QUESTIONS\n4) CONSTRAINTS\n5) VERBATIM\n6) NEXT STEPS\n7) DISCARDED\n";
    for (const [, gt] of SETS) {
      const nonExact = gt.mustSurvive.filter((i) => !i.exact).map((i) => i.id);
      expect(missingMustSurvive(skeleton, gt).filter((id) => nonExact.includes(id))).toEqual(nonExact);
    }
  });
});

describe("key matching", () => {
  it("respects word boundaries on alphanumeric edges", () => {
    expect(matchesKeys("Daten bleiben in der EU.", [["eu"]])).toBe(true);
    expect(matchesKeys("EU-Verarbeitung", [["eu"]])).toBe(true);
    expect(matchesKeys("eine neue Euro-Grenze", [["eu"]])).toBe(false);
    expect(matchesKeys("1240 Belege", [["240"]])).toBe(false);
  });

  it("a trailing or leading * lifts the boundary on that side", () => {
    expect(matchesKeys("Partitionen", [["partition*"]])).toBe(true);
    expect(matchesKeys("Partitionen", [["partition"]])).toBe(false);
    expect(matchesKeys("gesharded", [["*shard*"]])).toBe(true);
    expect(matchesKeys("gesharded", [["shard*"]])).toBe(false);
  });

  it("all groups must match, any alternative within a group", () => {
    expect(matchesKeys("Budget 400 €", [["400"], ["€", "eur"]])).toBe(true);
    expect(matchesKeys("Budget 400 EUR", [["400"], ["€", "eur"]])).toBe(true);
    expect(matchesKeys("Budget 400", [["400"], ["€", "eur"]])).toBe(false);
  });

  it("reads a decimal comma as a point but leaves thousands separators alone", () => {
    expect(normalizeForKeys("p95 1,6 s")).toBe("p95 1.6 s");
    expect(normalizeForKeys("12.000 Events")).toBe("12.000 events");
    expect(normalizeForKeys("12,000 events")).toBe("12,000 events");
    expect(matchesKeys("p95 aktuell 1,6 s", [["1.6 s"]])).toBe(true);
  });
});
