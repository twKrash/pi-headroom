// Tells the user how to get Headroom running when its proxy does not answer.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { isProxyHealthy } from "./client.ts";

export type ProxyState =
  | { readonly kind: "up" }
  | { readonly kind: "down"; readonly installed: boolean };

export async function checkProxy(
  baseUrl: string,
  pathEnv: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ProxyState> {
  if (await isProxyHealthy(baseUrl, signal)) return { kind: "up" };
  return { kind: "down", installed: await isOnPath("headroom", pathEnv) };
}

export function proxyError(state: ProxyState): string | undefined {
  if (state.kind === "up") return undefined;
  return state.installed ? "proxy not running" : "not installed";
}

export const INSTALL_COMMAND =
  'uv tool install --python 3.13 "headroom-ai[all]"';

// shortcut: checks POSIX executables only; Windows needs PATHEXT handling if Pi users there need the notice.
export async function isOnPath(
  command: string,
  pathEnv: string | undefined,
): Promise<boolean> {
  for (const dir of (pathEnv ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Not executable in this directory; keep looking.
    }
  }
  return false;
}

export function setupNotice(installed: boolean, baseUrl: string): string {
  const start = `headroom proxy --port ${proxyPort(baseUrl)}`;
  if (installed) {
    return `Headroom proxy is not answering at ${baseUrl}, so tool results are not compressed.\nStart it: ${start}`;
  }
  return [
    "Headroom is not installed, so tool results are not compressed.",
    `Install it: ${INSTALL_COMMAND}`,
    `Then start the proxy: ${start}`,
  ].join("\n");
}

function proxyPort(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.port || (url.protocol === "https:" ? "443" : "80");
}
