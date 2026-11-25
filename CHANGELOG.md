# Changelog

All notable changes will follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1]

### Changed

- The release workflow checks out `refs/tags/<tag>`, so a manual run that names a branch fails before publishing.
- npm keywords for discovery in the Pi package gallery and npm search.

## [0.1.0]

### Added

- Compresses single-text tool results of at least 2,000 characters through the Headroom proxy's `/v1/compress` (CCR mode) in Pi's `tool_result` hook, so each result is compressed once and the prompt cache prefix stays stable.
- `headroom_retrieve` tool that fetches originals behind `Retrieve more: hash=<hash>` markers.
- Pi's trailing truncation note is kept aside during compression and re-appended verbatim.
- Footer status: ready, compressing, session savings, or why the proxy is offline.
- Setup notice, once per Pi process, with install and start commands when the proxy does not answer.
- Requests carry `x-client: pi`, so the Headroom dashboard lists them under the Pi agent.
