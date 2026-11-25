import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  checkProxy,
  INSTALL_COMMAND,
  isOnPath,
  proxyError,
  setupNotice,
} from "../src/setup.ts";

const UNREACHABLE = "http://127.0.0.1:1";

let binDir: string;
let emptyDir: string;
let healthyUrl: string;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"status":"healthy"}');
});

before(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "pi-headroom-bin-"));
  emptyDir = await mkdtemp(path.join(os.tmpdir(), "pi-headroom-empty-"));
  await writeFile(path.join(binDir, "headroom"), "#!/bin/sh\n");
  await chmod(path.join(binDir, "headroom"), 0o755);
  await writeFile(path.join(emptyDir, "headroom"), "not executable");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  healthyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; // listen(0) on TCP always yields AddressInfo
});
after(async () => {
  server.close();
  await rm(binDir, { recursive: true });
  await rm(emptyDir, { recursive: true });
});

describe("isOnPath", () => {
  it("finds an executable in a later PATH entry", async () => {
    assert.equal(
      await isOnPath("headroom", [emptyDir, binDir].join(path.delimiter)),
      true,
    );
  });

  it("ignores a file that is not executable", async () => {
    assert.equal(await isOnPath("headroom", emptyDir), false);
  });

  it("is false when PATH is unset", async () => {
    assert.equal(await isOnPath("headroom", undefined), false);
  });
});

describe("checkProxy", () => {
  it("is up when the proxy answers", async () => {
    const state = await checkProxy(healthyUrl, emptyDir, undefined);

    assert.deepEqual(state, { kind: "up" });
    assert.equal(proxyError(state), undefined);
  });

  it("reports an installed Headroom whose proxy is not running", async () => {
    const state = await checkProxy(UNREACHABLE, binDir, undefined);

    assert.deepEqual(state, { kind: "down", installed: true });
    assert.equal(proxyError(state), "proxy not running");
  });

  it("reports Headroom as not installed", async () => {
    const state = await checkProxy(UNREACHABLE, emptyDir, undefined);

    assert.deepEqual(state, { kind: "down", installed: false });
    assert.equal(proxyError(state), "not installed");
  });
});

describe("setupNotice", () => {
  it("gives the install command and the start command when Headroom is missing", () => {
    const notice = setupNotice(false, "http://127.0.0.1:8787");

    assert.match(notice, /not installed/);
    assert.ok(notice.includes(INSTALL_COMMAND));
    assert.ok(notice.includes("headroom proxy --port 8787"));
  });

  it("uses the scheme's default port when the URL has none", () => {
    assert.ok(
      setupNotice(true, "http://localhost").includes(
        "headroom proxy --port 80",
      ),
    );
    assert.ok(
      setupNotice(true, "https://localhost").includes(
        "headroom proxy --port 443",
      ),
    );
  });

  it("gives only the start command when Headroom is installed", () => {
    const notice = setupNotice(true, "http://127.0.0.1:9000");

    assert.ok(!notice.includes(INSTALL_COMMAND));
    assert.ok(notice.includes("headroom proxy --port 9000"));
  });
});
