import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDecisions, planContext } from "../src/context.ts";
import type { Decision } from "../src/decisions.ts";

const LARGE = "x".repeat(2000);

const system = { role: "system", content: "prompt" };
const user = { role: "user", content: "go" };
function assistantCalling(id: string, command = "cat app.log") {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "bash",
        arguments: { command },
      },
    ],
  };
}
function toolResult(toolCallId: string, text = LARGE) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text" as const, text }],
    isError: false,
  };
}

const COMPRESSED: Decision = {
  toolCallId: "call_1",
  kind: "compressed",
  text: "short",
  tokensBefore: 100,
  tokensSaved: 90,
  hashes: [],
};

describe("planContext", () => {
  it("compresses tool results after the last assistant message", () => {
    const plan = planContext(
      [system, user, assistantCalling("call_1"), toolResult("call_1")],
      new Map(),
    );

    assert.deepEqual(plan.frozen, []);
    assert.deepEqual(plan.pending, [
      {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "cat app.log" },
        content: [{ type: "text", text: LARGE }],
      },
    ]);
  });

  it("freezes already-sent tool results that have no decision", () => {
    const plan = planContext(
      [
        user,
        assistantCalling("call_1"),
        toolResult("call_1"),
        assistantCalling("call_2"),
        toolResult("call_2"),
      ],
      new Map(),
    );

    assert.deepEqual(plan.frozen, ["call_1"]);
    assert.deepEqual(
      plan.pending.map((output) => output.toolCallId),
      ["call_2"],
    );
  });

  it("leaves decided, small and retrieve results alone", () => {
    const plan = planContext(
      [
        assistantCalling("call_1"),
        toolResult("call_1"),
        toolResult("call_small", "tiny"),
        { ...toolResult("call_r"), toolName: "headroom_retrieve" },
      ],
      new Map([["call_1", COMPRESSED]]),
    );

    assert.deepEqual(plan, { pending: [], frozen: [] });
  });

  it("takes the input from the matching call when one message makes several", () => {
    const assistant = {
      role: "assistant",
      content: [
        { type: "text", text: "running two commands" },
        {
          type: "toolCall",
          id: "call_1",
          name: "bash",
          arguments: { command: "ls" },
        },
        {
          type: "toolCall",
          id: "call_2",
          name: "bash",
          arguments: { command: "cat app.log" },
        },
      ],
    };

    const plan = planContext([assistant, toolResult("call_2")], new Map());

    assert.deepEqual(plan.pending[0]?.input, { command: "cat app.log" });
  });

  it("uses an empty input when no tool call matches", () => {
    const plan = planContext([user, toolResult("orphan")], new Map());

    assert.deepEqual(plan.pending[0]?.input, {});
  });
});

describe("applyDecisions", () => {
  it("replaces compressed results and leaves everything else as is", () => {
    const messages = [
      system,
      assistantCalling("call_1"),
      toolResult("call_1"),
      toolResult("call_2"),
    ];

    const result = applyDecisions(
      messages,
      new Map<string, Decision>([
        ["call_1", COMPRESSED],
        ["call_2", { toolCallId: "call_2", kind: "passthrough" }],
      ]),
    );

    assert.deepEqual(result, [
      system,
      messages[1],
      { ...toolResult("call_1"), content: [{ type: "text", text: "short" }] },
      messages[3],
    ]);
    assert.equal(result?.[0], system);
  });

  it("returns undefined when no decision changes anything", () => {
    assert.equal(
      applyDecisions([system, toolResult("call_9")], new Map()),
      undefined,
    );
  });
});
