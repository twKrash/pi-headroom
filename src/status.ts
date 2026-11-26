// Footer status for this Pi session's Headroom activity.

import type { Decision } from "./decisions.ts";

export interface Totals {
  readonly results: number;
  readonly tokensBefore: number;
  readonly tokensSaved: number;
}

export function totalsOf(decisions: Iterable<Decision>): Totals {
  let results = 0;
  let tokensBefore = 0;
  let tokensSaved = 0;
  for (const decision of decisions) {
    if (decision.kind !== "compressed") continue;
    results += 1;
    tokensBefore += decision.tokensBefore;
    tokensSaved += decision.tokensSaved;
  }
  return { results, tokensBefore, tokensSaved };
}

/** `proxyError` is set while the proxy is unusable; the status then shows why. */
export function formatStatus(
  totals: Totals,
  proxyError: string | undefined,
): string {
  if (proxyError !== undefined) return `headroom offline: ${proxyError}`;
  if (totals.results === 0) return "headroom ready";
  const percent = Math.round((totals.tokensSaved / totals.tokensBefore) * 100);
  const noun = totals.results === 1 ? "result" : "results";
  return `headroom -${formatTokens(totals.tokensSaved)} tok (${percent}%) · ${totals.results} ${noun}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
