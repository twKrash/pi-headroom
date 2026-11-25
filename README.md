<div align="center">

# Pi Headroom

**Smaller tool results for Pi, without breaking the prompt cache.**

[Headroom](https://github.com/headroomlabs-ai/headroom) compression for [Pi](https://github.com/earendil-works/pi) —
every provider, every subagent, compressed once and stored compressed.

[![npm version](https://img.shields.io/npm/v/@twkrash/pi-headroom)](https://www.npmjs.com/package/@twkrash/pi-headroom)

[![CI](https://github.com/twKrash/pi-headroom/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/twKrash/pi-headroom/actions/workflows/ci.yml)

[![GitHub release](https://img.shields.io/github/v/release/twKrash/pi-headroom)](https://github.com/twKrash/pi-headroom/releases/latest)

[![license: MIT](https://img.shields.io/github/license/twKrash/pi-headroom)](https://github.com/twKrash/pi-headroom/blob/main/LICENSE)

[![node: >=22.19.0](https://img.shields.io/node/v/@twkrash/pi-headroom)](https://www.npmjs.com/package/@twkrash/pi-headroom)

</div>

## What is Pi Headroom?

Coding agents spend most of their input tokens re-reading tool output: logs, JSON, search results, file listings. Headroom shrinks that output algorithmically, with no LLM call. On real tool output from Pi:

| Tool output | Before | After | How |
|---|---:|---:|---|
| 1,500-line application log with one `FATAL` line | 12,816 tokens | 47 tokens | repeated `INFO` lines folded; the `FATAL` line kept |
| 400-row JSON array | 13,880 tokens | 5,732 tokens | rewritten as a table, nothing lost |

Pi Headroom sends each large tool result through your local Headroom proxy the moment the tool finishes, and stores the compressed text in the session. Anything Headroom dropped stays one tool call away: the model calls `headroom_retrieve` with the hash from the `Retrieve more: hash=…` marker and gets the original back.

```text
caveman level: LITE | headroom -47.5k tok (89%) · 2 results | jev: auto
```

## Why another Headroom extension?

Pi already has Headroom extensions. They all compress in Pi's `context` hook, which runs before every model call: the conversation is compressed again on each request, and the compressed text is never stored. Provider prompt caches match on the exact bytes of the conversation prefix, so that approach relies on every pass producing byte-identical output for messages the provider has already cached.

Pi Headroom compresses in the `tool_result` hook instead, once per result, before the result first reaches the model. The session stores the compressed text, so every later request resends the same bytes. Cache stability holds by construction, not by repeating the same computation.

| | **Pi Headroom** | [@casualjim/pi-headroom](https://www.npmjs.com/package/@casualjim/pi-headroom) | [@cltec/pi-make-headroom](https://www.npmjs.com/package/@cltec/pi-make-headroom) | [pi-headroom](https://www.npmjs.com/package/pi-headroom) |
|---|---|---|---|---|
| When it compresses | once, when a tool finishes | before every model call | before every model call | before every model call |
| What the session stores | compressed text | original text | original text | original text |
| Headroom proxy | yours, never started for you; setup notice if missing | yours | installed and run in a private venv | installed with pip and run by the extension |
| `headroom_retrieve` tool | ✓ | ✓ | — | — |
| Pi's truncation note (`[Showing lines … Full output: …]`) | kept aside, re-appended verbatim | — | — | — |
| Subagents | one `settings.json` entry | — | — | — |
| Headroom dashboard | listed as **Pi** (`x-client: pi`) | — | — | — |
| Pi package namespace | `@earendil-works` | `@earendil-works` (also runs in omp) | `@earendil-works` | `@mariozechner` |

The comparison reflects each package's published source as of 2026-11-25. A "—" means the feature was not found in that package's source, not that it cannot be configured. Pick the one that fits:

- **Pi Headroom** if you want cache-stable savings across every provider and subagent and you run the Headroom proxy yourself.
- **@cltec/pi-make-headroom** if you want the extension to install and manage Headroom for you.
- **@casualjim/pi-headroom** if you also run omp and want one extension for both, or want its `/headroom` command to switch compression on and off.

## Install

1. Install and start Headroom:

   ```sh
   uv tool install --python 3.13 "headroom-ai[all]"
   headroom proxy --port 8787
   ```

2. Install the extension:

   ```sh
   pi install npm:@twkrash/pi-headroom
   ```

3. Start Pi. The footer shows `headroom ready`.

If the proxy does not answer at session start, Pi shows a notice with the install or start command, once per Pi process, and tool results pass through unchanged.

### Subagents

[`pi-subagents`](https://www.npmjs.com/package/pi-subagents) starts a child without auto-discovered extensions whenever the agent has its own `extensions` list. Add Pi Headroom to `subagents.defaultSubagentOnlyExtensions` in `~/.pi/agent/settings.json` so every child loads it:

```json
"subagents": {
  "defaultSubagentOnlyExtensions": ["~/.pi/agent/npm/node_modules/@twkrash/pi-headroom/src/index.ts"]
}
```

Children share the same proxy, so `headroom_retrieve` works inside them too.

## What gets compressed

- A tool result whose content is one text block of at least 2,000 characters.
- Not results that mix text and images, not shorter results, and never `headroom_retrieve`'s own output.
- Headroom decides what it can shrink. Output without a recognisable shape, such as plain `seq` lines, comes back unchanged and the original is kept.
- Extensions that shrink tool output in their own `tool_result` handler, such as [context-mode](https://www.npmjs.com/package/context-mode), can run first. Pi Headroom then sees their output and compresses it only if it is still at least 2,000 characters, so nothing is compressed twice.

## Footer and dashboard

| Footer status | Meaning |
|---|---|
| `headroom ready` | The proxy answered; nothing compressed yet this session. |
| `headroom compressing…` | A tool result is on its way through the proxy. |
| `headroom -47.5k tok (89%) · 2 results` | Tokens saved this session, the share of the compressed results, and their count. |
| `headroom offline: <reason>` | Headroom is not installed, its proxy is not running, or the proxy returned an error. |

Every request carries `x-client: pi`, so the Headroom dashboard at <http://127.0.0.1:8787/dashboard> lists Pi's savings under its own **Pi** agent, next to Claude Code or any other client using the same proxy.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HEADROOM_URL` | `http://127.0.0.1:8787` | Headroom proxy base URL. |

## Limits

- Originals live in the proxy's memory for 30 minutes (`HEADROOM_CCR_TTL_SECONDS`) and are lost when the proxy restarts. The session keeps only the compressed text, so after that the model has to rerun the tool.
- The "not installed" check looks for a POSIX executable named `headroom` on `PATH`.
- Turns run through `pi-claude-bridge` execute their tools inside Claude Code, outside Pi's `tool_result` hook.

## Run from source

```sh
git clone https://github.com/twKrash/pi-headroom.git
cd pi-headroom
npm ci
npm run format:check && npm run lint && npm run typecheck && npm run knip
npm test
pi install ./
```

## License

[MIT](LICENSE)
