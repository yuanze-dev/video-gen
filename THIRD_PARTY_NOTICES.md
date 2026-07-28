# Third-party notices

Littlestart CLI is proprietary (`UNLICENSED`). It bundles or depends on third-party software whose terms remain in effect.

## Remotion

The renderer uses Remotion 4.0.481 packages under the Remotion license, including `remotion`, `@remotion/renderer`, `@remotion/media-parser` and `@remotion/bundler`. The separately MIT-licensed `@remotion/three` package is listed below.

Remotion uses a special license. Eligibility for the free license depends on the user or organization, and other commercial use requires a company license. Distribution or deployment owners must review the exact terms and configure `REMOTION_LICENSE_KEY` when required:

- https://github.com/remotion-dev/remotion/blob/v4.0.481/LICENSE.md
- https://remotion.dev/license

This package does not grant or imply a Remotion license.

## ElevenLabs MCP sidecar (Electron macOS arm64)

The macOS arm64 Electron application can bundle the official
`elevenlabs-mcp` 0.11.0 server under the MIT License. The build is pinned to
upstream source commit `afc22357432db9e8b33991a83d41906001f6d759` and official
wheel SHA-256
`814af638d3df2ec9d76ba2aeb1247ffa47f5ed8f8d11f60953b402667e4b172a`.

The server's required and imported dependency closure includes
`fuzzywuzzy` 0.18.0 under GPLv2 and
`python-Levenshtein`/`Levenshtein` 0.27.3 under GPL-2.0-or-later. Those
components and their license metadata enter the frozen sidecar. PyInstaller's
license exception does not relicense bundled dependencies, and choosing
`onedir` instead of `onefile` does not remove redistribution obligations.

Production publication is blocked unless a separate legal review approves the
complete sidecar distribution and all corresponding source, license-text,
notice, and compatibility obligations have been fulfilled. The release variable
`ELEVENLABS_MCP_DISTRIBUTION_APPROVED=true` records that approval; it does not
itself satisfy those obligations.

- https://github.com/elevenlabs/elevenlabs-mcp/tree/afc22357432db9e8b33991a83d41906001f6d759
- https://pypi.org/project/elevenlabs-mcp/0.11.0/
- https://pypi.org/project/fuzzywuzzy/0.18.0/
- https://pypi.org/project/python-Levenshtein/0.27.3/
- https://pypi.org/project/Levenshtein/0.27.3/
- https://pyinstaller.org/en/stable/license.html

## Currently identified bundled open-source components

- React and React DOM 19.2.4 — MIT. See `runtime/licenses/React-MIT.txt`.
- three.js 0.184.0 — MIT. See `runtime/licenses/Three-MIT.txt`.
- `@remotion/three` 4.0.481 — MIT.
- `@react-three/fiber` 9.6.1 — MIT.
- Zustand 5.0.14 — MIT.
- Mediabunny 1.47.0 — Mozilla Public License 2.0.
- Zod 4.3.6 — MIT. See `runtime/licenses/Zod-MIT.txt`.
- Noto Sans SC via Fontsource 5.2.10 — SIL Open Font License 1.1. See `runtime/licenses/Noto-Sans-SC-OFL-1.1.txt`.

This is an identified-notices list, not a complete SBOM. Installed npm dependencies may include further transitive notices in their own package directories. Before distribution, generate the exact dependency graph from the release lockfile, review all direct and transitive licenses, include any required license texts, and satisfy the MPL-2.0 notice/source obligations that apply to the distributed artifact.
