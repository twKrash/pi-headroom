// Decides whether one new tool result goes through Headroom, and what replaces it.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { compressToolOutput } from "./client.ts";

export const RETRIEVE_TOOL_NAME = "headroom_retrieve";
// Below this size the proxy round-trip costs more than it can save.
export const MIN_CHARS = 2000;

export interface ToolOutput {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly content: readonly (TextContent | ImageContent)[];
}

/**
 * - `skipped`: not eligible (too small, mixed content, no model); nothing to record.
 * - `aborted`: the request was cancelled before an answer; decide on the next request.
 * - `unchanged`: Headroom saved nothing; the original is sent.
 * - `failed`: the proxy failed; the original is sent.
 * - `compressed`: `text` replaces the original from now on.
 */
export type Outcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "aborted" }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "compressed";
      readonly text: string;
      readonly tokensBefore: number;
      readonly tokensSaved: number;
      readonly hashes: readonly string[];
    }
  | { readonly kind: "failed"; readonly error: Error };

const SKIPPED: Outcome = { kind: "skipped" };

export async function compressToolResult(
  baseUrl: string,
  output: ToolOutput,
  model: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  const text = compressibleText(output);
  if (text === undefined || model === undefined) return SKIPPED;
  const { body, note } = splitTrailingNote(text);
  try {
    const compressed = await compressToolOutput(
      baseUrl,
      {
        model,
        toolName: output.toolName,
        toolCallId: output.toolCallId,
        input: output.input,
        text: body,
      },
      signal,
    );
    if (compressed.tokensSaved <= 0) return { kind: "unchanged" };
    return { kind: "compressed", ...compressed, text: compressed.text + note };
  } catch (error) {
    if (signal?.aborted) return { kind: "aborted" };
    return {
      kind: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

// Pi ends truncated output with a one-line note such as
// "[Showing lines 580-1501 of 1501 (50.0KB limit). Full output: /tmp/pi-bash-….log]".
// With it attached, Headroom's content router treats the text as mixed and skips it,
// so the note is kept aside during compression and re-appended verbatim.
const TRAILING_NOTE = /\n\n\[[^\n]*\]\n?$/;

function splitTrailingNote(text: string): {
  readonly body: string;
  readonly note: string;
} {
  const match = TRAILING_NOTE.exec(text);
  return match
    ? { body: text.slice(0, match.index), note: match[0] }
    : { body: text, note: "" };
}

// Only large single-text results are compressed; mixed text and image results pass through.
export function compressibleText(output: ToolOutput): string | undefined {
  // Retrieved originals must reach the model in full, or retrieval loops forever.
  if (output.toolName === RETRIEVE_TOOL_NAME) return undefined;
  const [first, ...rest] = output.content;
  if (first?.type !== "text" || rest.length > 0) return undefined;
  return first.text.length >= MIN_CHARS ? first.text : undefined;
}
