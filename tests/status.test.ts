import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Outcome } from "../src/handler.ts";
import {
  type Footer,
  formatFooter,
  nextFooter,
  START_FOOTER,
} from "../src/status.ts";

function compressed(tokensBefore: number, tokensSaved: number): Outcome {
  return { kind: "compressed", text: "x", tokensBefore, tokensSaved };
}

function after(...outcomes: Outcome[]): Footer {
  return outcomes.reduce(nextFooter, START_FOOTER);
}

describe("footer", () => {
  it("shows ready before anything is compressed", () => {
    assert.equal(formatFooter(START_FOOTER), "headroom ready");
  });

  it("shows one compressed result with its saving", () => {
    assert.equal(
      formatFooter(after(compressed(800, 200))),
      "headroom -200 tok (25%) · 1 result",
    );
  });

  it("totals several results and ignores skipped ones", () => {
    const footer = after(
      compressed(39_547, 39_306),
      { kind: "skipped" },
      compressed(13_880, 8_148),
    );

    assert.equal(formatFooter(footer), "headroom -47.5k tok (89%) · 2 results");
  });

  it("switches units exactly at a thousand and a million", () => {
    assert.match(formatFooter(after(compressed(2000, 999))), /-999 tok/);
    assert.match(formatFooter(after(compressed(2000, 1000))), /-1\.0k tok/);
    assert.match(
      formatFooter(after(compressed(2_000_000, 1_000_000))),
      /-1\.0M tok/,
    );
  });

  it("uses millions for large totals", () => {
    assert.equal(
      formatFooter(after(compressed(2_000_000, 1_500_000))),
      "headroom -1.5M tok (75%) · 1 result",
    );
  });

  it("shows why the proxy failed", () => {
    const footer = after({
      kind: "failed",
      error: new Error("Headroom proxy answered HTTP 500"),
    });

    assert.equal(
      formatFooter(footer),
      "headroom offline: Headroom proxy answered HTTP 500",
    );
  });

  it("returns to totals once a compression succeeds again", () => {
    const footer = after(
      { kind: "failed", error: new Error("down") },
      compressed(100, 50),
    );

    assert.equal(formatFooter(footer), "headroom -50 tok (50%) · 1 result");
  });

  it("keeps the totals across a failure", () => {
    const footer = after(
      compressed(100, 50),
      { kind: "failed", error: new Error("down") },
      compressed(100, 50),
    );

    assert.equal(formatFooter(footer), "headroom -100 tok (50%) · 2 results");
  });
});
