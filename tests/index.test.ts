import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  execute(
    toolCallId: string,
    params: { hash: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<unknown>;
}

const LARGE = "x".repeat(5000);
const HASH = "abcdef12";

let healthy: boolean;
let compressStatus: number;
let compressCalls: number;
let retrieveStatus: number;
const server = createServer((request, response: ServerResponse) => {
  request.resume();
  request.on("end", () => {
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.url === "/health") return send(healthy ? 200 : 503, {});
    if (request.url === "/v1/compress") {
      compressCalls += 1;
      return send(compressStatus, {
        messages: [{ role: "tool", content: "short" }],
        tokens_before: 1000,
        tokens_after: 10,
        ccr_hashes: [HASH],
      });
    }
    if (request.url === `/v1/retrieve/${HASH}`) {
      return send(retrieveStatus, { original_content: "from the proxy" });
    }
    send(404, {});
  });
});

let headroom: (pi: ExtensionAPI) => void;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The extension reads HEADROOM_URL once at module load, so it is set before the import.
  process.env.HEADROOM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen(0) on TCP always yields AddressInfo
  headroom = (await import("../src/index.ts")).default;
});
after(() => server.close());
beforeEach(() => {
  healthy = true;
  compressStatus = 200;
  compressCalls = 0;
  retrieveStatus = 200;
});

const system = { role: "system", content: "prompt" };
const user = { role: "user", content: "go" };
const answer = { role: "assistant", content: [] };
function assistantCalling(id: string) {
  return {
    role: "assistant",
    content: [
      { type: "toolCall", id, name: "bash", arguments: { command: "cat" } },
    ],
  };
}
function toolResult(toolCallId: string, text = LARGE) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
  };
}
function compressedResult(toolCallId: string) {
  return {
    ...toolResult(toolCallId),
    content: [{ type: "text", text: "short" }],
  };
}

function loadExtension(
  options: { model?: { id: string } | null; branch?: unknown[] } = {},
) {
  const handlers = new Map<string, Handler>();
  const tools: RegisteredTool[] = [];
  const branch: unknown[] = [...(options.branch ?? [])];
  const fakePi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    appendEntry: (customType: string, data: unknown) =>
      branch.push({ type: "custom", customType, data }),
  };
  // The fake implements only the ExtensionAPI members the extension calls.
  headroom(fakePi as unknown as ExtensionAPI);
  const statuses: string[] = [];
  const notices: string[] = [];
  const ctx = {
    model:
      options.model === null
        ? undefined
        : (options.model ?? { id: "claude-opus-5-5" }),
    signal: undefined,
    ui: {
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: (message: string) => notices.push(message),
    },
    sessionManager: { getBranch: () => branch },
  };
  const emit = (event: string, payload: unknown) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no ${event} handler`);
    return handler(payload, ctx);
  };
  const context = (messages: unknown[]) =>
    emit("context_with_system", { type: "context_with_system", messages });
  const stored = () =>
    branch
      .filter(
        (entry): entry is { customType: string; data: unknown } =>
          typeof entry === "object" &&
          entry !== null &&
          "customType" in entry &&
          entry.customType === "headroom-decision",
      )
      .map((entry) => entry.data);
  const retrieveTool = () => {
    const tool = tools.find((t) => t.name === "headroom_retrieve");
    if (!tool) throw new Error("headroom_retrieve not registered");
    return tool;
  };
  return {
    emit,
    context,
    statuses,
    notices,
    branch,
    stored,
    ctx,
    retrieveTool,
  };
}

describe("session start", () => {
  it("shows ready when the proxy answers", async () => {
    const pi = loadExtension();

    await pi.emit("session_start", {});

    assert.deepEqual(pi.statuses, ["headroom ready"]);
    assert.deepEqual(pi.notices, []);
  });

  it("notifies once per process when Headroom is not installed", async () => {
    healthy = false;
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const pi = loadExtension();

      await pi.emit("session_start", {});
      await pi.emit("session_start", {});

      assert.equal(pi.notices.length, 1);
      assert.match(pi.notices[0] ?? "", /not installed/);
      assert.equal(pi.statuses.at(-1), "headroom offline: not installed");
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("restores stored decisions on resume and replays them without the proxy", async () => {
    const first = loadExtension();
    await first.context([
      user,
      assistantCalling("call_1"),
      toolResult("call_1"),
    ]);
    compressCalls = 0;

    const resumed = loadExtension({ branch: first.branch });
    await resumed.emit("session_start", {});
    const result = await resumed.context([
      user,
      assistantCalling("call_1"),
      toolResult("call_1"),
      answer,
    ]);

    assert.equal(resumed.statuses.at(-1), "headroom -990 tok (99%) · 1 result");
    assert.deepEqual(result, {
      messages: [
        user,
        assistantCalling("call_1"),
        compressedResult("call_1"),
        answer,
      ],
    });
    assert.equal(compressCalls, 0);
  });

  it("warns about stored decisions that fail validation", async () => {
    const pi = loadExtension({
      branch: [
        {
          type: "custom",
          customType: "headroom-decision",
          data: { kind: "x" },
        },
      ],
    });

    await pi.emit("session_start", {});

    assert.match(pi.notices[0] ?? "", /1 stored decision\(s\) are invalid/);
  });
});

describe("context_with_system", () => {
  it("compresses a new tool result once and replays the stored text", async () => {
    const pi = loadExtension();
    const messages = [
      system,
      user,
      assistantCalling("call_1"),
      toolResult("call_1"),
    ];
    const compressed = [
      system,
      user,
      assistantCalling("call_1"),
      compressedResult("call_1"),
    ];

    const first = await pi.context(messages);
    const second = await pi.context([...messages, answer]);

    assert.deepEqual(first, { messages: compressed });
    assert.deepEqual(second, { messages: [...compressed, answer] });
    assert.equal(compressCalls, 1);
    assert.equal(pi.stored().length, 1);
    assert.equal(pi.statuses.at(-1), "headroom -990 tok (99%) · 1 result");
  });

  it("never compresses a result that was already sent", async () => {
    const pi = loadExtension();

    const result = await pi.context([
      user,
      assistantCalling("call_1"),
      toolResult("call_1"),
      answer,
    ]);

    assert.equal(result, undefined);
    assert.equal(compressCalls, 0);
    assert.deepEqual(pi.stored(), [
      { toolCallId: "call_1", kind: "passthrough" },
    ]);
  });

  it("sends the original and records passthrough when the proxy fails", async () => {
    compressStatus = 500;
    const pi = loadExtension();
    const messages = [assistantCalling("call_1"), toolResult("call_1")];

    const result = await pi.context(messages);
    const again = await pi.context(messages);

    assert.equal(result, undefined);
    assert.equal(again, undefined);
    assert.equal(compressCalls, 1);
    assert.match(pi.statuses.at(-1) ?? "", /headroom offline: .*HTTP 500/);
  });

  it("records nothing without a selected model", async () => {
    const pi = loadExtension({ model: null });

    const result = await pi.context([
      assistantCalling("call_1"),
      toolResult("call_1"),
    ]);

    assert.equal(result, undefined);
    assert.deepEqual(pi.stored(), []);
    assert.equal(compressCalls, 0);
  });

  it("ignores small tool results", async () => {
    const pi = loadExtension();

    const result = await pi.context([
      assistantCalling("call_1"),
      toolResult("call_1", "small"),
    ]);

    assert.equal(result, undefined);
    assert.equal(compressCalls, 0);
    assert.deepEqual(pi.stored(), []);
  });
});

describe("headroom_retrieve", () => {
  it("returns the original from the proxy", async () => {
    const pi = loadExtension();

    const result = await pi
      .retrieveTool()
      .execute("c", { hash: HASH }, undefined, undefined, pi.ctx);

    assert.deepEqual(result, {
      content: [{ type: "text", text: "from the proxy" }],
      details: { hash: HASH },
    });
  });

  it("falls back to the original kept in the session when the proxy lost it", async () => {
    retrieveStatus = 404;
    const pi = loadExtension({
      branch: [
        { type: "message", message: toolResult("call_1", "kept original") },
      ],
    });
    await pi.context([assistantCalling("call_1"), toolResult("call_1")]);

    const result = await pi
      .retrieveTool()
      .execute("c", { hash: HASH }, undefined, undefined, pi.ctx);

    assert.deepEqual(result, {
      content: [{ type: "text", text: "kept original" }],
      details: { hash: HASH },
    });
  });

  it("fails when neither the proxy nor the session has the original", async () => {
    retrieveStatus = 404;
    const pi = loadExtension();

    await assert.rejects(
      pi
        .retrieveTool()
        .execute("c", { hash: HASH }, undefined, undefined, pi.ctx),
      /expired or the proxy restarted/,
    );
  });

  it("tells the model how to use the retrieve marker", () => {
    assert.match(
      loadExtension().retrieveTool().description,
      /Retrieve more: hash=<hash>/,
    );
  });
});
