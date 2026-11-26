// Per-tool-result compression decisions. Each decision is stored once as a session
// custom entry and replayed on every later request, so the bytes sent for a tool
// result never change after its first request and the provider prompt cache holds.

import { isRecord } from "./guards.ts";
import type { Outcome } from "./handler.ts";

export const DECISION_ENTRY_TYPE = "headroom-decision";

export type Decision =
  | {
      readonly toolCallId: string;
      readonly kind: "compressed";
      readonly text: string;
      readonly tokensBefore: number;
      readonly tokensSaved: number;
      /** CCR hashes in `text`; each one leads back to the original. */
      readonly hashes: readonly string[];
    }
  | { readonly toolCallId: string; readonly kind: "passthrough" };

export interface BranchDecisions {
  readonly decisions: ReadonlyMap<string, Decision>;
  /** Stored entries that failed validation; their tool results are sent unchanged. */
  readonly invalid: number;
}

export function decisionsFromEntries(
  entries: readonly unknown[],
): BranchDecisions {
  const decisions = new Map<string, Decision>();
  let invalid = 0;
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== DECISION_ENTRY_TYPE
    )
      continue;
    const decision = parseDecision(entry.data);
    if (decision) decisions.set(decision.toolCallId, decision);
    else invalid += 1;
  }
  return { decisions, invalid };
}

/**
 * The decision to store for a new tool result. Once a result has been sent unchanged
 * (no saving, proxy failure) it stays unchanged; skipped and aborted results store
 * nothing, so their next request decides again.
 */
export function decisionFor(
  toolCallId: string,
  outcome: Outcome,
): Decision | undefined {
  switch (outcome.kind) {
    case "skipped":
    case "aborted":
      return undefined;
    case "unchanged":
    case "failed":
      return { toolCallId, kind: "passthrough" };
    case "compressed":
      return {
        toolCallId,
        kind: "compressed",
        text: outcome.text,
        tokensBefore: outcome.tokensBefore,
        tokensSaved: outcome.tokensSaved,
        hashes: outcome.hashes,
      };
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The original text of the tool result whose compressed form carries `hash`. */
export function originalForHash(
  hash: string,
  decisions: ReadonlyMap<string, Decision>,
  entries: readonly unknown[],
): string | undefined {
  const owner = [...decisions.values()].find(
    (decision) =>
      decision.kind === "compressed" && decision.hashes.includes(hash),
  );
  if (!owner) return undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (
      isRecord(message) &&
      message.role === "toolResult" &&
      message.toolCallId === owner.toolCallId
    ) {
      return textOf(message.content);
    }
  }
  return undefined;
}

function parseDecision(data: unknown): Decision | undefined {
  if (!isRecord(data) || typeof data.toolCallId !== "string") return undefined;
  if (data.kind === "passthrough") {
    return { toolCallId: data.toolCallId, kind: "passthrough" };
  }
  if (
    data.kind !== "compressed" ||
    typeof data.text !== "string" ||
    typeof data.tokensBefore !== "number" ||
    typeof data.tokensSaved !== "number" ||
    !isStringArray(data.hashes)
  )
    return undefined;
  return {
    toolCallId: data.toolCallId,
    kind: "compressed",
    text: data.text,
    tokensBefore: data.tokensBefore,
    tokensSaved: data.tokensSaved,
    hashes: data.hashes,
  };
}

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((block) => isRecord(block) && block.type === "text")
    .map((block) => (isRecord(block) ? block.text : undefined));
  return texts.every((text) => typeof text === "string")
    ? texts.join("\n")
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
