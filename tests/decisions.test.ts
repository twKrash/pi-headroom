import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DECISION_ENTRY_TYPE,
  type Decision,
  decisionFor,
  decisionsFromEntries,
  originalForHash,
} from "../src/decisions.ts";

const COMPRESSED: Decision = {
  toolCallId: "call_1",
  kind: "compressed",
  text: "short [Retrieve more: hash=abcdef12]",
  tokensBefore: 1000,
  tokensSaved: 990,
  hashes: ["abcdef12"],
};

function custom(data: unknown, customType = DECISION_ENTRY_TYPE) {
  return { type: "custom", id: "e", customType, data };
}

function toolResultEntry(toolCallId: string, text: string) {
  return {
    type: "message",
    id: `m_${toolCallId}`,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    },
  };
}

describe("decisionsFromEntries", () => {
  it("rebuilds compressed and passthrough decisions from custom entries", () => {
    const passthrough: Decision = { toolCallId: "call_2", kind: "passthrough" };

    const { decisions, invalid } = decisionsFromEntries([
      custom(COMPRESSED),
      toolResultEntry("call_1", "original"),
      custom({ other: true }, "someone-else"),
      custom(passthrough),
    ]);

    assert.deepEqual([...decisions.values()], [COMPRESSED, passthrough]);
    assert.equal(invalid, 0);
  });

  it("ignores other entry kinds that carry the decision type", () => {
    const { decisions, invalid } = decisionsFromEntries([
      {
        type: "custom_message",
        customType: DECISION_ENTRY_TYPE,
        data: COMPRESSED,
      },
    ]);

    assert.equal(decisions.size, 0);
    assert.equal(invalid, 0);
  });

  for (const [label, data] of [
    ["no toolCallId", { kind: "passthrough" }],
    ["an unknown kind", { toolCallId: "c", kind: "maybe" }],
    ["compressed without text", { ...COMPRESSED, text: 5 }],
    ["compressed without tokensBefore", { ...COMPRESSED, tokensBefore: "1" }],
    ["compressed without tokensSaved", { ...COMPRESSED, tokensSaved: null }],
    ["hashes that are not strings", { ...COMPRESSED, hashes: [1] }],
    ["a non-object", "call_1"],
  ] as const) {
    it(`counts a stored decision with ${label} as invalid`, () => {
      const { decisions, invalid } = decisionsFromEntries([custom(data)]);

      assert.equal(decisions.size, 0);
      assert.equal(invalid, 1);
    });
  }
});

describe("decisionFor", () => {
  it("stores nothing for skipped and aborted results", () => {
    assert.equal(decisionFor("c", { kind: "skipped" }), undefined);
    assert.equal(decisionFor("c", { kind: "aborted" }), undefined);
  });

  it("stores passthrough once a result was sent unchanged", () => {
    const passthrough = { toolCallId: "c", kind: "passthrough" };

    assert.deepEqual(decisionFor("c", { kind: "unchanged" }), passthrough);
    assert.deepEqual(
      decisionFor("c", { kind: "failed", error: new Error("down") }),
      passthrough,
    );
  });

  it("stores the compressed text, savings and hashes", () => {
    const decision = decisionFor("call_1", {
      kind: "compressed",
      text: COMPRESSED.kind === "compressed" ? COMPRESSED.text : "",
      tokensBefore: 1000,
      tokensSaved: 990,
      hashes: ["abcdef12"],
    });

    assert.deepEqual(decision, COMPRESSED);
  });
});

describe("originalForHash", () => {
  const entries = [
    toolResultEntry("call_0", "other result"),
    toolResultEntry("call_1", "the full original"),
  ];
  const decisions = new Map([["call_1", COMPRESSED]]);

  it("returns the original tool result behind a hash", () => {
    assert.equal(
      originalForHash("abcdef12", decisions, entries),
      "the full original",
    );
  });

  it("reads originals only from message entries", () => {
    const decoy = {
      type: "custom",
      customType: "other",
      message: toolResultEntry("call_1", "not the original").message,
    };

    assert.equal(
      originalForHash("abcdef12", decisions, [decoy, ...entries]),
      "the full original",
    );
  });

  it("returns the text of an original that also holds an image", () => {
    const base = toolResultEntry("call_1", "text part");
    const withImage = {
      ...base,
      message: {
        ...base.message,
        content: [
          ...base.message.content,
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
    };

    assert.equal(
      originalForHash("abcdef12", decisions, [withImage]),
      "text part",
    );
  });

  it("returns undefined for a hash no decision carries", () => {
    assert.equal(originalForHash("ffffffff", decisions, entries), undefined);
  });

  it("returns undefined when the original is not on this branch", () => {
    assert.equal(
      originalForHash("abcdef12", decisions, [entries[0]]),
      undefined,
    );
  });
});
