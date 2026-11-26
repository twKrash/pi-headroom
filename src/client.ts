// HTTP client for the local Headroom proxy: /v1/compress and /v1/retrieve.

import { isRecord } from "./guards.ts";

export interface CompressRequest {
  readonly model: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly text: string;
}

export interface Compressed {
  readonly text: string;
  readonly tokensBefore: number;
  readonly tokensSaved: number;
  /** CCR hashes of content Headroom dropped; each leads back to the original. */
  readonly hashes: readonly string[];
}

const TIMEOUT_MS = 5000;
// CCR hashes are lowercase hex; the check keeps a model-supplied value out of the URL path.
const HASH_PATTERN = /^[0-9a-f]{8,64}$/;

export async function compressToolOutput(
  baseUrl: string,
  request: CompressRequest,
  signal: AbortSignal | undefined,
): Promise<Compressed> {
  const body = {
    model: request.model,
    // "ccr" keeps dropped content retrievable through headroom_retrieve.
    config: { mode: "ccr" },
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: request.toolCallId,
            type: "function",
            function: {
              name: request.toolName,
              arguments: JSON.stringify(request.input),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: request.toolCallId, content: request.text },
    ],
  };
  const response = await fetch(`${baseUrl}/v1/compress`, {
    method: "POST",
    // x-client attributes these requests to "Pi" on the Headroom dashboard.
    headers: { "content-type": "application/json", "x-client": "pi" },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  return parseCompressResponse(await readJson(response));
}

export async function retrieveOriginal(
  baseUrl: string,
  hash: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!HASH_PATTERN.test(hash))
    throw new Error(`invalid Headroom hash: ${JSON.stringify(hash)}`);
  const response = await fetch(`${baseUrl}/v1/retrieve/${hash}`, {
    signal: withTimeout(signal),
  });
  if (response.status === 404) {
    throw new Error(
      `Headroom has no original for hash ${hash}: it expired or the proxy restarted. Rerun the tool.`,
    );
  }
  const json = await readJson(response);
  if (!isRecord(json) || typeof json.original_content !== "string") {
    throw new Error("Headroom /v1/retrieve returned no original_content");
  }
  return json.original_content;
}

function parseCompressResponse(json: unknown): Compressed {
  if (!isRecord(json) || !Array.isArray(json.messages))
    throw new Error("Headroom /v1/compress returned no messages");
  const last: unknown = json.messages.at(-1);
  if (
    !isRecord(last) ||
    last.role !== "tool" ||
    typeof last.content !== "string"
  ) {
    throw new Error("Headroom /v1/compress returned no tool message");
  }
  if (
    typeof json.tokens_before !== "number" ||
    typeof json.tokens_after !== "number"
  ) {
    throw new Error("Headroom /v1/compress returned no token counts");
  }
  return {
    text: last.content,
    tokensBefore: json.tokens_before,
    tokensSaved: json.tokens_before - json.tokens_after,
    hashes: ccrHashes(json.ccr_hashes),
  };
}

function ccrHashes(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((hash) => typeof hash === "string"))
    throw new Error("Headroom /v1/compress returned malformed ccr_hashes");
  return value;
}

export async function isProxyHealthy(
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: withTimeout(signal),
    });
    return response.ok;
  } catch {
    // Unreachable proxy and network errors both mean "not healthy"; callers only show state.
    return false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok)
    throw new Error(`Headroom proxy answered HTTP ${response.status}`);
  return response.json();
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
