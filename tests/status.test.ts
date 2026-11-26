import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Decision } from "../src/decisions.ts";
import { formatStatus, totalsOf } from "../src/status.ts";

function compressed(tokensBefore: number, tokensSaved: number): Decision {
  return {
    toolCallId: `call_${tokensBefore}_${tokensSaved}`,
    kind: "compressed",
    text: "x",
    tokensBefore,
    tokensSaved,
    hashes: [],
  };
}

function status(...decisions: Decision[]): string {
  return formatStatus(totalsOf(decisions), undefined);
}

describe("status", () => {
  it("shows ready before anything is compressed", () => {
    assert.equal(status(), "headroom ready");
  });

  it("shows one compressed result with its saving", () => {
    assert.equal(
      status(compressed(800, 200)),
      "headroom -200 tok (25%) · 1 result",
    );
  });

  it("totals compressed results and ignores passthrough ones", () => {
    assert.equal(
      status(
        compressed(39_547, 39_306),
        { toolCallId: "call_p", kind: "passthrough" },
        compressed(13_880, 8_148),
      ),
      "headroom -47.5k tok (89%) · 2 results",
    );
  });

  it("switches units exactly at a thousand and a million", () => {
    assert.match(status(compressed(2000, 999)), /-999 tok/);
    assert.match(status(compressed(2000, 1000)), /-1\.0k tok/);
    assert.match(status(compressed(2_000_000, 1_000_000)), /-1\.0M tok/);
  });

  it("computes the share from exact totals", () => {
    assert.match(status(compressed(2, 1)), /\(50%\)/);
  });

  it("uses millions for large totals", () => {
    assert.equal(
      status(compressed(2_000_000, 1_500_000)),
      "headroom -1.5M tok (75%) · 1 result",
    );
  });

  it("shows why the proxy is offline instead of totals", () => {
    assert.equal(
      formatStatus(totalsOf([compressed(100, 50)]), "proxy not running"),
      "headroom offline: proxy not running",
    );
  });
});
