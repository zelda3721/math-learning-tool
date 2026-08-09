import { describe, expect, it } from "vitest";
import { MASTERY_PARAMS } from "@mathtutor/schema";
import { applyAttempt, effectiveP, masteryBand } from "../src/mastery.js";

describe("applyAttempt", () => {
  it("starts from p0 and gains on correct", () => {
    const next = applyAttempt(undefined, true, 0);
    expect(next.p).toBeCloseTo(0.3 + 0.25 * 0.7, 6);
    expect(next.evidenceN).toBe(1);
  });
  it("discounts gain by hint level", () => {
    const noHint = applyAttempt({ p: 0.5, evidenceN: 3 }, true, 0);
    const l3 = applyAttempt({ p: 0.5, evidenceN: 3 }, true, 3);
    expect(noHint.p).toBeGreaterThan(l3.p);
    expect(l3.p).toBeCloseTo(0.5 + 0.25 * 0.2 * 0.5, 6);
  });
  it("decays on wrong", () => {
    const next = applyAttempt({ p: 0.8, evidenceN: 5 }, false, 0);
    expect(next.p).toBeCloseTo(0.48, 6);
    expect(next.evidenceN).toBe(6);
  });
});

describe("effectiveP half-life decay", () => {
  it("regresses toward p0 with 30-day half-life", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const p = effectiveP({ p: 0.9, lastEvidenceAt: thirtyDaysAgo });
    expect(p).toBeCloseTo(MASTERY_PARAMS.initialP + (0.9 - MASTERY_PARAMS.initialP) * 0.5, 3);
  });
  it("no decay when fresh", () => {
    expect(effectiveP({ p: 0.9, lastEvidenceAt: new Date().toISOString() })).toBeCloseTo(0.9, 3);
  });
});

describe("masteryBand", () => {
  it("requires both p and evidence for lit (行为验证)", () => {
    expect(masteryBand(0.9, 1)).toBe("glow");
    expect(masteryBand(0.9, 3)).toBe("lit");
    expect(masteryBand(0.5, 10)).toBe("glow");
    expect(masteryBand(0.2, 10)).toBe("dim");
  });
});
