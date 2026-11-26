// Which tool results in a request are new, which were already sent, and what each
// one must look like on the wire.
//
// A tool result after the last assistant message has never been sent: it may be
// compressed now. One before it was part of an earlier request and may already sit
// in the provider's prompt cache, so without a stored decision it stays unchanged
// for good. This is the in-session form of Headroom's own cache mode, which
// freezes already-cached messages and compresses only new content.

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
): ContextPlan {
  const lastAssistant = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const pending: ToolOutput[] = [];
  const frozen: string[] = [];
  messages.forEach((message, index) => {
    if (!isToolResult(message) || decisions.has(message.toolCallId)) return;
    const output: ToolOutput = {
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      input: inputOf(messages, message.toolCallId),
      content: message.content,
    };
    if (compressibleText(output) === undefined) return;
    if (index > lastAssistant) pending.push(output);
    else frozen.push(message.toolCallId);
  });
  return { pending, frozen };
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
