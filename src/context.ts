// Which tool results in a request are new, which were already sent, and what each
// one must look like on the wire.
//
// A tool result after the last assistant message has never been sent: it may be
// compressed now. One before it was part of an earlier request and may already sit
// in the provider's prompt cache, so without a stored decision it stays unchanged
// for good. This is the in-session form of Headroom's own cache mode, which
// freezes already-cached messages and compresses only new content.
//
// A compaction replaces the history before the kept messages with a summary, so the
// first request after it has no cached prefix past the system prompt. On that request
// every kept result that is not yet compressed may be compressed at no cache cost.

import type { Decision } from "./decisions.ts";
import { isRecord } from "./guards.ts";
import { compressibleText, type ToolOutput } from "./handler.ts";

interface Message {
  readonly role: string;
}

export interface ContextPlan {
  /** New tool results to compress now, in request order. */
  readonly pending: readonly ToolOutput[];
  /** Already-sent tool results with no decision; they are recorded as passthrough. */
  readonly frozen: readonly string[];
}

export function planContext(
  messages: readonly Message[],
  decisions: ReadonlyMap<string, Decision>,
  cacheCold: boolean,
): ContextPlan {
  const pending: ToolOutput[] = [];
  const frozen: string[] = [];
  // Walk back from the newest message: a tool result with an assistant message after
  // it was part of an earlier request.
  let answered = false;
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant") answered = true;
    if (!isToolResult(message)) continue;
    if (!isOpen(decisions.get(message.toolCallId), cacheCold)) continue;
    const output: ToolOutput = {
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      input: inputOf(messages, message.toolCallId),
      content: message.content,
    };
    if (compressibleText(output) === undefined) continue;
    // With a cold cache nothing is cached, so nothing needs to stay frozen.
    if (cacheCold || !answered) pending.unshift(output);
    else frozen.unshift(message.toolCallId);
  }
  return { pending, frozen };
}

/**
 * True on the first request after a compaction: the branch's newest compaction comes
 * after its newest assistant message, so no request has been sent since.
 */
export function isCacheCold(entries: readonly unknown[]): boolean {
  const lastCompaction = entries.findLastIndex(
    (entry) => isRecord(entry) && entry.type === "compaction",
  );
  const lastAssistant = entries.findLastIndex(
    (entry) =>
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "assistant",
  );
  return lastCompaction > lastAssistant;
}

/** The messages with every compressed decision applied, or undefined when none applies. */
export function applyDecisions<M extends Message>(
  messages: readonly M[],
  decisions: ReadonlyMap<string, Decision>,
): M[] | undefined {
  let changed = false;
  const result = messages.map((message) => {
    if (!isToolResult(message)) return message;
    const decision = decisions.get(message.toolCallId);
    if (decision?.kind !== "compressed") return message;
    changed = true;
    return { ...message, content: [{ type: "text", text: decision.text }] };
  });
  return changed ? result : undefined;
}

interface ToolResultMessage extends Message {
  readonly role: "toolResult";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: ToolOutput["content"];
}

// A compressed result stays as it is. A passthrough result stays unchanged while its
// bytes may be cached, and may be compressed again once the cache is cold.
function isOpen(decision: Decision | undefined, cacheCold: boolean): boolean {
  if (decision === undefined) return true;
  return decision.kind === "passthrough" && cacheCold;
}

function isToolResult(message: Message): message is ToolResultMessage {
  return message.role === "toolResult";
}

function inputOf(
  messages: readonly Message[],
  toolCallId: string,
): Readonly<Record<string, unknown>> {
  for (const message of messages) {
    const args =
      message.role === "assistant"
        ? callArguments(message, toolCallId)
        : undefined;
    if (args) return args;
  }
  return {};
}

function callArguments(
  message: Message,
  toolCallId: string,
): Record<string, unknown> | undefined {
  const content: unknown = "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) return undefined;
  const call: unknown = content.find(
    (block: unknown) =>
      isRecord(block) && block.type === "toolCall" && block.id === toolCallId,
  );
  return isRecord(call) && isRecord(call.arguments)
    ? call.arguments
    : undefined;
}
