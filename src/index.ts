// Headroom for Pi: compresses large tool results through the local Headroom proxy,
// for every provider, and lets the model fetch dropped originals back.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { retrieveOriginal } from "./client.ts";
import { compressToolResult, RETRIEVE_TOOL_NAME } from "./handler.ts";
import { checkProxy, proxyError, setupNotice } from "./setup.ts";
import { formatFooter, nextFooter, START_FOOTER } from "./status.ts";

const BASE_URL = process.env.HEADROOM_URL ?? "http://127.0.0.1:8787";
const STATUS_KEY = "headroom";

// Pi's extension loader requires a default-exported factory.
export default function headroom(pi: ExtensionAPI): void {
  let footer = START_FOOTER;
  // One setup notice per Pi process; /new and /resume start sessions without restarting it.
  let noticeShown = false;

  pi.on("session_start", async (_event, ctx) => {
    const proxy = await checkProxy(BASE_URL, process.env.PATH, ctx.signal);
    footer = { ...START_FOOTER, proxyError: proxyError(proxy) };
    ctx.ui.setStatus(STATUS_KEY, formatFooter(footer));
    if (proxy.kind === "up" || noticeShown) return;
    noticeShown = true;
    ctx.ui.notify(setupNotice(proxy.installed, BASE_URL), "warning");
  });

  pi.on("tool_result", async (event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, "headroom compressing…");
    const outcome = await compressToolResult(
      BASE_URL,
      event,
      ctx.model?.id,
      ctx.signal,
    );
    footer = nextFooter(footer, outcome);
    ctx.ui.setStatus(STATUS_KEY, formatFooter(footer));
    return outcome.kind === "compressed"
      ? { content: [{ type: "text", text: outcome.text }] }
      : undefined;
  });

  pi.registerTool({
    name: RETRIEVE_TOOL_NAME,
    label: "Headroom retrieve",
    description:
      "Fetch the original content that Headroom replaced with a `Retrieve more: hash=<hash>` marker. " +
      "Originals expire about 30 minutes after compression; if expired, rerun the original tool.",
    parameters: Type.Object({
      hash: Type.String({ description: "The hash from the marker" }),
    }),
    async execute(_toolCallId, params, signal) {
      const text = await retrieveOriginal(BASE_URL, params.hash, signal);
      return {
        content: [{ type: "text", text }],
        details: { hash: params.hash },
      };
    },
  });
}
