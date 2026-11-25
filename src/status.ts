// Footer status for this Pi session's Headroom activity.

import type { Outcome } from "./handler.ts";

export interface Footer {
  readonly results: number;
  readonly tokensBefore: number;
  readonly tokensSaved: number;
  /** Set while the proxy is unusable; the footer then shows why instead of totals. */
  readonly proxyError: string | undefined;
}

export const START_FOOTER: Footer = {
  results: 0,
  tokensBefore: 0,
  tokensSaved: 0,
  proxyError: undefined,
};

export function nextFooter(footer: Footer, outcome: Outcome): Footer {
  switch (outcome.kind) {
    case "skipped":
      return footer;
    case "failed":
      return { ...footer, proxyError: outcome.error.message };
    case "compressed":
      return {
        results: footer.results + 1,
        tokensBefore: footer.tokensBefore + outcome.tokensBefore,
        tokensSaved: footer.tokensSaved + outcome.tokensSaved,
        proxyError: undefined,
      };
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

export function formatFooter(footer: Footer): string {
  if (footer.proxyError !== undefined)
    return `headroom offline: ${footer.proxyError}`;
  if (footer.results === 0) return "headroom ready";
  const percent = Math.round((footer.tokensSaved / footer.tokensBefore) * 100);
  const noun = footer.results === 1 ? "result" : "results";
  return `headroom -${formatTokens(footer.tokensSaved)} tok (${percent}%) · ${footer.results} ${noun}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
