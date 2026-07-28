"""Strict-stdio launcher for the pinned official ElevenLabs MCP server.

The upstream 0.11.0 console entry point prints a human banner to stdout before
starting FastMCP. Stdout is the MCP JSON-RPC transport, so the Electron sidecar
uses this packaging-only launcher while leaving every upstream tool unchanged.
"""

from elevenlabs_mcp.server import mcp


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
