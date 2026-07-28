# ElevenLabs MCP sidecar

This directory defines the optional official ElevenLabs MCP sidecar for the
macOS arm64 Electron application. It does not add Windows, Linux, or Intel Mac
support.

## Pinned upstream

- Distribution: `elevenlabs-mcp==0.11.0`
- Source commit: `afc22357432db9e8b33991a83d41906001f6d759`
- Official wheel SHA-256: `814af638d3df2ec9d76ba2aeb1247ffa47f5ed8f8d11f60953b402667e4b172a`
- Runtime: CPython 3.12.11, frozen as a PyInstaller 6.21.0 `onedir`

`lock.json` fixes the complete resolution used by the current darwin-arm64
build. The build downloads the official server wheel, verifies its required
SHA-256, installs every locked distribution without dependency re-resolution,
and refuses non-arm64/non-macOS hosts.

## Build and package

Run from any working directory:

```bash
npm run build:mcp:elevenlabs
```

The host must provide `uv` and the exact locked CPython 3.12.11 interpreter.
GitHub Actions installs that interpreter with `actions/setup-python` before the
build; the script will not silently select a different patch version.

The output is written atomically to
`mcp/elevenlabs/dist/darwin-arm64/`. Electron copies that directory outside
`app.asar` to `Contents/Resources/mcp/elevenlabs/darwin-arm64/`.

`npm run electron:build` always builds the sidecar and makes a missing or invalid
copy fatal. A low-level, direct `electron-builder` development invocation may
omit it unless `LITTLESTART_REQUIRE_ELEVENLABS_MCP=true` is set; CI and release
builds always set that flag.

The packaged smoke test uses a deliberately invalid, non-secret API key and
only sends MCP `initialize` and `tools/list`. It validates strict JSON-RPC
stdout and the `compose_music` schema; it never sends `tools/call` and cannot
consume ElevenLabs credits.

The Electron CLI installer repeats the same no-paid boundary through the
packaged Node launcher. Installation only commits when the launcher starts the
sidecar, completes `initialize`/`tools/list`, observes all pinned music tools,
and reports the verified bundle identity. The user's real API Key is neither
read nor required for this self-check.

## Why the wrapper exists

The upstream 0.11.0 console `main()` prints `Starting MCP server` to stdout.
That is not a valid MCP message and becomes observable when Python stdout is
unbuffered. `stdio_server.py` imports the official registered `mcp` object and
calls `mcp.run()` directly. It changes startup framing only; official tools are
not modified.

## Distribution gate

The upstream package is MIT, but its required, imported runtime closure contains
`fuzzywuzzy` (GPLv2) and `python-Levenshtein`/`Levenshtein`
(GPL-2.0-or-later). Freezing as `onedir` or `onefile` still distributes those
components. Production publication is therefore blocked unless the repository
variable `ELEVENLABS_MCP_DISTRIBUTION_APPROVED` is exactly `true` after legal
review and fulfillment of all source, license-text, notice, and compatibility
obligations. The variable records approval; it does not itself satisfy them.

Every release must also retain the generated Python distribution inventory,
the packaged lock, third-party notices, Developer ID signatures on all nested
Mach-O files, and notarization of the outer application.
