# Third-party notices

Littlestart CLI is proprietary (`UNLICENSED`). It bundles or depends on third-party software whose terms remain in effect.

## Remotion

The renderer uses Remotion 4.0.481 packages under the Remotion license, including `remotion`, `@remotion/renderer`, `@remotion/media-parser` and `@remotion/bundler`. The separately MIT-licensed `@remotion/three` package is listed below.

Remotion uses a special license. Eligibility for the free license depends on the user or organization, and other commercial use requires a company license. Distribution or deployment owners must review the exact terms and configure `REMOTION_LICENSE_KEY` when required:

- https://github.com/remotion-dev/remotion/blob/v4.0.481/LICENSE.md
- https://remotion.dev/license

This package does not grant or imply a Remotion license.

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
