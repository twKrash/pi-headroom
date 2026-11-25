import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { isProxyHealthy, retrieveOriginal } from "../src/client.ts";
import {
  compressToolResult,
  MIN_CHARS,
  RETRIEVE_TOOL_NAME,
  type ToolOutput,
} from "../src/handler.ts";

type Reply = (
  request: IncomingMessage,
  body: string,
  response: ServerResponse,
) => void;

const MODEL = "claude-opus-5-5";
const LARGE = "x".repeat(MIN_CHARS);

let reply: Reply;
let requests: { url: string; body: string; client: string | undefined }[];
let baseUrl: string;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  request.on("end", () => {
    const client = request.headers["x-client"];
    requests.push({
      url: request.url ?? "",
      body,
      client: typeof client === "string" ? client : undefined,
    });
    reply(request, body, response);
  });
});

function json(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function compressReply(content: string, before: number, after: number): Reply {
  return (_request, _body, response) =>
    json(response, 200, {
      messages: [
        { role: "assistant" },
        { role: "tool", tool_call_id: "call_1", content },
      ],
      tokens_before: before,
      tokens_after: after,
    });
}

function bashOutput(text: string, toolName = "bash"): ToolOutput {
  return {
    toolName,
    toolCallId: "call_1",
    input: { command: "cat app.log" },
    content: [{ type: "text", text }],
  };
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen(0) on TCP always yields AddressInfo
});
after(() => server.close());
beforeEach(() => {
  requests = [];
  reply = compressReply("short", 1000, 10);
});

describe("compressToolResult", () => {
  it("replaces a large tool result with the proxy's compressed text", async () => {
    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE),
      MODEL,
      undefined,
    );

    assert.deepEqual(outcome, {
      kind: "compressed",
      text: "short",
      tokensBefore: 1000,
      tokensSaved: 990,
    });
    const sent = JSON.parse(requests[0]?.body ?? "{}");
    assert.equal(requests[0]?.url, "/v1/compress");
    assert.equal(requests[0]?.client, "pi");
    assert.deepEqual(sent.config, { mode: "ccr" });
    assert.equal(sent.model, MODEL);
    assert.equal(sent.messages[0].tool_calls[0].function.name, "bash");
    assert.deepEqual(sent.messages[1], {
      role: "tool",
      tool_call_id: "call_1",
      content: LARGE,
    });
  });

  it("compresses truncated output without Pi's trailing note, then re-appends the note", async () => {
    const note =
      "\n\n[Showing lines 580-1501 of 1501 (50.0KB limit). Full output: /tmp/pi-bash-1.log]";

    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE + note),
      MODEL,
      undefined,
    );

    assert.deepEqual(outcome, {
      kind: "compressed",
      text: `short${note}`,
      tokensBefore: 1000,
      tokensSaved: 990,
    });
    assert.equal(
      JSON.parse(requests[0]?.body ?? "{}").messages[1].content,
      LARGE,
    );
  });

  it("leaves bracketed text inside the output alone", async () => {
    const text = `${LARGE}\n\n[not a trailing note]\nlast line`;

    await compressToolResult(baseUrl, bashOutput(text), MODEL, undefined);

    assert.equal(
      JSON.parse(requests[0]?.body ?? "{}").messages[1].content,
      text,
    );
  });

  it("keeps a saving of a single token", async () => {
    reply = compressReply("short", 11, 10);

    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE),
      MODEL,
      undefined,
    );

    assert.equal(outcome.kind, "compressed");
  });

  it("takes the compressed text from the last message", async () => {
    reply = (_request, _body, response) =>
      json(response, 200, {
        messages: [
          { role: "assistant" },
          { role: "assistant", content: "not this" },
          { role: "tool", content: "short" },
        ],
        tokens_before: 100,
        tokens_after: 10,
      });

    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE),
      MODEL,
      undefined,
    );

    assert.equal(outcome.kind === "compressed" ? outcome.text : "", "short");
  });

  for (const [label, payload, expected] of [
    ["a JSON array", [], /no messages/],
    ["a null body", null, /no messages/],
    [
      "a messages field that is not a list",
      { messages: "x", tokens_before: 2, tokens_after: 1 },
      /no messages/,
    ],
    [
      "a last message that is not an object",
      { messages: ["x"], tokens_before: 2, tokens_after: 1 },
      /no tool message/,
    ],
    [
      "a last message that is not a tool message",
      {
        messages: [{ role: "assistant", content: "x" }],
        tokens_before: 2,
        tokens_after: 1,
      },
      /no tool message/,
    ],
    [
      "tool content that is not text",
      {
        messages: [{ role: "tool", content: 5 }],
        tokens_before: 2,
        tokens_after: 1,
      },
      /no tool message/,
    ],
    [
      "no tokens_before",
      { messages: [{ role: "tool", content: "x" }], tokens_after: 1 },
      /no token counts/,
    ],
    [
      "no tokens_after",
      { messages: [{ role: "tool", content: "x" }], tokens_before: 2 },
      /no token counts/,
    ],
  ] as const) {
    it(`reports failure for a response with ${label}`, async () => {
      reply = (_request, _body, response) => json(response, 200, payload);

      const outcome = await compressToolResult(
        baseUrl,
        bashOutput(LARGE),
        MODEL,
        undefined,
      );

      assert.match(
        outcome.kind === "failed" ? outcome.error.message : "",
        expected,
      );
    });
  }

  it("skips a result with no content blocks", async () => {
    const output: ToolOutput = { ...bashOutput(LARGE), content: [] };

    assert.deepEqual(
      await compressToolResult(baseUrl, output, MODEL, undefined),
      { kind: "skipped" },
    );
  });

  it("skips results below the size threshold without calling the proxy", async () => {
    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE.slice(1)),
      MODEL,
      undefined,
    );

    assert.deepEqual(outcome, { kind: "skipped" });
    assert.equal(requests.length, 0);
  });

  it("never compresses headroom_retrieve output", async () => {
    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE, RETRIEVE_TOOL_NAME),
      MODEL,
      undefined,
    );

    assert.deepEqual(outcome, { kind: "skipped" });
    assert.equal(requests.length, 0);
  });

  it("skips results that mix text and images", async () => {
    const output: ToolOutput = {
      ...bashOutput(LARGE),
      content: [
        { type: "text", text: LARGE },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    };

    assert.deepEqual(
      await compressToolResult(baseUrl, output, MODEL, undefined),
      { kind: "skipped" },
    );
    assert.equal(requests.length, 0);
  });

  it("skips when no model is selected", async () => {
    assert.deepEqual(
      await compressToolResult(
        baseUrl,
        bashOutput(LARGE),
        undefined,
        undefined,
      ),
      { kind: "skipped" },
    );
    assert.equal(requests.length, 0);
  });

  it("keeps the original when compression saves nothing", async () => {
    reply = compressReply(LARGE, 500, 500);

    assert.deepEqual(
      await compressToolResult(baseUrl, bashOutput(LARGE), MODEL, undefined),
      { kind: "skipped" },
    );
  });

  it("reports failure when the proxy answers with an error status", async () => {
    reply = (_request, _body, response) =>
      json(response, 500, { error: "boom" });

    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE),
      MODEL,
      undefined,
    );

    assert.equal(outcome.kind, "failed");
    assert.match(
      outcome.kind === "failed" ? outcome.error.message : "",
      /HTTP 500/,
    );
  });

  it("reports failure when the proxy response has no tool message", async () => {
    reply = (_request, _body, response) =>
      json(response, 200, {
        messages: [{ role: "assistant" }],
        tokens_before: 10,
        tokens_after: 1,
      });

    const outcome = await compressToolResult(
      baseUrl,
      bashOutput(LARGE),
      MODEL,
      undefined,
    );

    assert.equal(outcome.kind, "failed");
  });

  it("reports failure when the proxy is unreachable", async () => {
    const outcome = await compressToolResult(
      "http://127.0.0.1:1",
      bashOutput(LARGE),
      MODEL,
      undefined,
    );

    assert.equal(outcome.kind, "failed");
  });

  it("skips quietly when the user aborts the request", async () => {
    reply = () => {}; // never answers; the abort ends the request
    const controller = new AbortController();
    const pending = compressToolResult(
      baseUrl,
      bashOutput(LARGE),
      MODEL,
      controller.signal,
    );
    controller.abort();

    assert.deepEqual(await pending, { kind: "skipped" });
  });
});

describe("isProxyHealthy", () => {
  it("is true when /health answers 200", async () => {
    reply = (_request, _body, response) =>
      json(response, 200, { status: "healthy" });

    assert.equal(await isProxyHealthy(baseUrl, undefined), true);
    assert.equal(requests[0]?.url, "/health");
  });

  it("is false when /health answers an error status", async () => {
    reply = (_request, _body, response) =>
      json(response, 503, { status: "starting" });

    assert.equal(await isProxyHealthy(baseUrl, undefined), false);
  });

  it("is false when the proxy is unreachable", async () => {
    assert.equal(await isProxyHealthy("http://127.0.0.1:1", undefined), false);
  });
});

describe("retrieveOriginal", () => {
  it("returns the stored original for a hash", async () => {
    reply = (_request, _body, response) =>
      json(response, 200, { hash: "7ab7164e", original_content: "full log" });

    assert.equal(
      await retrieveOriginal(baseUrl, "7ab7164e", undefined),
      "full log",
    );
    assert.equal(requests[0]?.url, "/v1/retrieve/7ab7164e");
  });

  it("rejects a malformed hash without calling the proxy", async () => {
    await assert.rejects(
      retrieveOriginal(baseUrl, "../stats", undefined),
      /invalid Headroom hash/,
    );
    assert.equal(requests.length, 0);
  });

  it("explains an expired hash", async () => {
    reply = (_request, _body, response) =>
      json(response, 404, { detail: "not found" });

    await assert.rejects(
      retrieveOriginal(baseUrl, "7ab7164e", undefined),
      /expired or the proxy restarted/,
    );
  });

  for (const [label, payload] of [
    ["a JSON array", []],
    ["original_content that is not text", { original_content: 5 }],
  ] as const) {
    it(`rejects a retrieve response with ${label}`, async () => {
      reply = (_request, _body, response) => json(response, 200, payload);

      await assert.rejects(
        retrieveOriginal(baseUrl, "7ab7164e", undefined),
        /no original_content/,
      );
    });
  }
});
