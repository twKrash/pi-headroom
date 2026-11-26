// Headroom for Pi: compresses new tool results through the local Headroom proxy before
// each model call, replays each stored decision byte for byte, and keeps the original
// results in the session.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { retrieveOriginal } from "./client.ts";
import { applyDecisions, isCacheCold, planContext } from "./context.ts";
import {
  DECISION_ENTRY_TYPE,
  type Decision,
  decisionFor,
  decisionsFromEntries,
  originalForHash,
} from "./decisions.ts";
import {
  compressToolResult,
  RETRIEVE_TOOL_NAME,
  type ToolOutput,
} from "./handler.ts";
import { checkProxy, proxyError, setupNotice } from "./setup.ts";
import { formatStatus, totalsOf } from "./status.ts";

const BASE_URL = process.env.HEADROOM_URL ?? "http://127.0.0.1:8787";
const STATUS_KEY = "headroom";

/** Per-process state; only the handlers below write it. */
interface State {
  decisions: Map<string, Decision>;
  offline: string | undefined;
  /** One setup notice per Pi process; /new and /resume start sessions without restarting it. */
  noticeShown: boolean;
}

// Pi's extension loader requires a default-exported factory.
export default function headroom(pi: ExtensionAPI): void {
  const state: State = {
    decisions: new Map(),
    offline: undefined,
    noticeShown: false,
  };
  pi.on("session_start", (_event, ctx) => startSession(state, ctx));
  // context_with_system sends the returned list as is; the plain `context` hook would
  // rebuild the leading system message from a changed list and move the cached prefix.
  pi.on("context_with_system", async (event, ctx) => {
    const plan = planContext(
      event.messages,
      state.decisions,
      isCacheCold(ctx.sessionManager.getBranch()),
    );
    for (const toolCallId of plan.frozen) {
      record(pi, state, { toolCallId, kind: "passthrough" });
    }
    for (const output of plan.pending) await decide(pi, state, output, ctx);
    const messages = applyDecisions(event.messages, state.decisions);
    return messages ? { messages } : undefined;
  });
  pi.registerTool({
    name: RETRIEVE_TOOL_NAME,
    label: "Headroom retrieve",
    description:
      "Fetch the original content that Headroom replaced with a `Retrieve more: hash=<hash>` marker.",
    parameters: Type.Object({
      hash: Type.String({ description: "The hash from the marker" }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const text = await retrieve(state, params.hash, signal, ctx);
      return {
        content: [{ type: "text", text }],
        details: { hash: params.hash },
      };
    },
  });
}

async function startSession(
  state: State,
  ctx: ExtensionContext,
): Promise<void> {
  const branch = decisionsFromEntries(ctx.sessionManager.getBranch());
  state.decisions = new Map(branch.decisions);
  const proxy = await checkProxy(BASE_URL, process.env.PATH, ctx.signal);
  state.offline = proxyError(proxy);
  showStatus(state, ctx);
  if (branch.invalid > 0) {
    ctx.ui.notify(
      `Headroom: ${branch.invalid} stored decision(s) are invalid; those tool results are sent unchanged.`,
      "warning",
    );
  }
  if (proxy.kind === "up" || state.noticeShown) return;
  state.noticeShown = true;
  ctx.ui.notify(setupNotice(proxy.installed, BASE_URL), "warning");
}

async function decide(
  pi: ExtensionAPI,
  state: State,
  output: ToolOutput,
  ctx: ExtensionContext,
): Promise<void> {
  ctx.ui.setStatus(STATUS_KEY, "headroom compressing…");
  const outcome = await compressToolResult(
    BASE_URL,
    output,
    ctx.model?.id,
    ctx.signal,
  );
  const decision = decisionFor(output.toolCallId, outcome);
  if (decision) record(pi, state, decision);
  if (outcome.kind === "failed") state.offline = outcome.error.message;
  if (outcome.kind === "compressed") state.offline = undefined;
  showStatus(state, ctx);
}

function record(pi: ExtensionAPI, state: State, decision: Decision): void {
  // A retry after a compaction that again saves nothing changes nothing.
  const stored = state.decisions.get(decision.toolCallId);
  if (stored?.kind === "passthrough" && decision.kind === "passthrough") return;
  state.decisions.set(decision.toolCallId, decision);
  pi.appendEntry(DECISION_ENTRY_TYPE, decision);
}

function showStatus(state: State, ctx: ExtensionContext): void {
  ctx.ui.setStatus(
    STATUS_KEY,
    formatStatus(totalsOf(state.decisions.values()), state.offline),
  );
}

async function retrieve(
  state: State,
  hash: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<string> {
  try {
    return await retrieveOriginal(BASE_URL, hash, signal);
  } catch (error) {
    // The proxy keeps originals for 30 minutes; the session keeps them for good.
    const original = originalForHash(
      hash,
      state.decisions,
      ctx.sessionManager.getBranch(),
    );
    if (original === undefined) throw error;
    return original;
  }
}
