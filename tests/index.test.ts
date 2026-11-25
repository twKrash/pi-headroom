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
  ): Promise<unknown>;
}

let healthy: boolean;
const server = createServer((request, response: ServerResponse) => {
  request.resume();
  request.on("end", () => {
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.url === "/health") return send(healthy ? 200 : 503, {});
    if (request.url === "/v1/compress") {
      return send(200, {
        messages: [{ role: "assistant" }, { role: "tool", content: "short" }],
        tokens_before: 1000,
        tokens_after: 10,
      });
    }
    if (request.url === "/v1/retrieve/abcdef12") {
      return send(200, { original_content: "full original" });
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
});

function loadExtension(
  model: { id: string } | null = { id: "claude-opus-5-5" },
) {
  const handlers = new Map<string, Handler>();
  const tools: RegisteredTool[] = [];
  const fakePi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  };
  // The fake implements only the two ExtensionAPI members the extension calls.
  headroom(fakePi as unknown as ExtensionAPI);
  const statuses: string[] = [];
  const notices: string[] = [];
  const ctx = {
    model: model ?? undefined,
    signal: undefined,
    ui: {
      setStatus: (_key: string, text: string) => statuses.push(text),
      notify: (message: string) => notices.push(message),
    },
  };
  const emit = (event: string, payload: unknown) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no ${event} handler`);
    return handler(payload, ctx);
  };
  return { emit, tools, statuses, notices };
}

function toolResult(text: string) {
  return {
    toolName: "bash",
    toolCallId: "call_1",
    input: {},
    content: [{ type: "text", text }],
  };
}

describe("extension", () => {
  it("shows ready at session start when the proxy answers", async () => {
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

  it("replaces a large tool result and shows the session saving", async () => {
    const pi = loadExtension();

    const result = await pi.emit("tool_result", toolResult("x".repeat(5000)));

    assert.deepEqual(result, { content: [{ type: "text", text: "short" }] });
    assert.deepEqual(pi.statuses, [
      "headroom compressing…",
      "headroom -990 tok (99%) · 1 result",
    ]);
  });

  it("passes results through when no model is selected", async () => {
    const pi = loadExtension(null);

    const result = await pi.emit("tool_result", toolResult("x".repeat(5000)));

    assert.equal(result, undefined);
    assert.equal(pi.statuses.at(-1), "headroom ready");
  });

  it("tells the model how to use the retrieve marker and when originals expire", () => {
    const tool = loadExtension().tools.find(
      (t) => t.name === "headroom_retrieve",
    );

    assert.match(tool?.description ?? "", /Retrieve more: hash=<hash>/);
    assert.match(tool?.description ?? "", /30 minutes/);
  });

  it("leaves a small tool result unchanged", async () => {
    const pi = loadExtension();

    assert.equal(await pi.emit("tool_result", toolResult("small")), undefined);
  });

  it("registers headroom_retrieve, which returns the original", async () => {
    const pi = loadExtension();
    const tool = pi.tools.find((t) => t.name === "headroom_retrieve");

    const result = await tool?.execute(
      "call_2",
      { hash: "abcdef12" },
      undefined,
    );

    assert.deepEqual(result, {
      content: [{ type: "text", text: "full original" }],
      details: { hash: "abcdef12" },
    });
  });
});
