import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditRuntimeArtifacts,
  normalizeAndAuditRuntimeArtifacts,
} from "../scripts/cli-runtime-artifacts.mjs";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-runtime-artifact-"));
  await fs.writeFile(
    path.join(directory, "index.html"),
    '<script>window.remotion_cwd = "/Users/build/work/video-gen";</script>\n' +
      '<script>window.remotion_staticFiles = [{"name":"asset","lastModified":1730000000000}];</script>\n',
  );
  await fs.writeFile(
    path.join(directory, "bundle.js.map"),
    JSON.stringify({
      version: 3,
      sources: [
        "ignored|/Users/build/work/video-gen/node_modules/example/index.js|worker_threads",
      ],
      sourcesContent: ["/* ignored */"],
      sourceRoot: "/Users/build/work/video-gen",
      names: [],
      mappings: "",
    }),
  );
  return directory;
}

test("runtime artifact normalization removes source-map paths and timestamps", async () => {
  const runtimeSite = await fixture();
  try {
    const result = await normalizeAndAuditRuntimeArtifacts({
      runtimeSite,
      projectRoot: "/Users/build/work/video-gen",
      homeDirectory: "/Users/build",
    });
    assert.equal(result.sourceMapCount, 1);
    const sourceMap = JSON.parse(await fs.readFile(path.join(runtimeSite, "bundle.js.map"), "utf8"));
    assert.deepEqual(sourceMap.sources, ["ignored|./node_modules/example/index.js|worker_threads"]);
    assert.equal(sourceMap.sourceRoot, ".");
    const index = await fs.readFile(path.join(runtimeSite, "index.html"), "utf8");
    assert.match(index, /window\.remotion_cwd = "\/littlestart"/);
    assert.match(index, /"lastModified":0/);
    assert.doesNotMatch(index, /Users\/build/);
  } finally {
    await fs.rm(runtimeSite, { recursive: true, force: true });
  }
});

test("runtime artifact audit rejects an absolute path outside the project root", async () => {
  const runtimeSite = await fixture();
  try {
    await fs.writeFile(
      path.join(runtimeSite, "bundle.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["ignored|C:\\agent\\cache\\module.js|worker_threads"],
        names: [],
        mappings: "",
      }),
    );
    await assert.rejects(
      auditRuntimeArtifacts({
        runtimeSite,
        projectRoot: "/repo",
        homeDirectory: "/home/build",
      }),
      /sourcemap .* 包含绝对文件路径/,
    );
  } finally {
    await fs.rm(runtimeSite, { recursive: true, force: true });
  }
});

test("short container build roots are normalized only as complete path segments", async () => {
  const runtimeSite = await fixture();
  try {
    await fs.writeFile(
      path.join(runtimeSite, "bundle.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["ignored|/src/node_modules/example/index.js|worker_threads"],
        sourcesContent: ['const selector = "/srcset/image.png";'],
        names: [],
        mappings: "",
      }),
    );
    await normalizeAndAuditRuntimeArtifacts({
      runtimeSite,
      projectRoot: "/src",
      homeDirectory: "/root",
    });
    const sourceMap = JSON.parse(await fs.readFile(path.join(runtimeSite, "bundle.js.map"), "utf8"));
    assert.deepEqual(sourceMap.sources, ["ignored|./node_modules/example/index.js|worker_threads"]);
    assert.deepEqual(sourceMap.sourcesContent, ['const selector = "/srcset/image.png";']);
  } finally {
    await fs.rm(runtimeSite, { recursive: true, force: true });
  }
});
