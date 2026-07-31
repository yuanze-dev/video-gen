import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const ROOT = process.cwd();

// Node's type-stripping mode intentionally follows ESM's strict extension
// resolution while the app source uses bundler-style extensionless imports.
// Bundle the public config surface in memory so tests exercise exactly the
// same graph as the shipped CLI without writing generated artifacts.
const bundle = await build({
  stdin: {
    contents: `
      export {
        CliConfigValidationError,
        deepMerge,
        loadCliConfig,
      } from "./cli/config.ts";
      export { ProjectConfig, makeDefaultConfig } from "./lib/config-schema.ts";
      export {
        ASSET_SLOTS,
        BUILTIN_ASSETS,
        listBuiltinAssetMetadata,
      } from "./lib/asset-registry.ts";
      export { resolveConfig } from "./lib/resolved.ts";
      export { builtinAssetFile } from "./cli/runtime.ts";
    `,
    loader: "ts",
    resolveDir: ROOT,
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent",
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].contents,
).toString("base64")}`;

type TestAssetRef = {
  kind: string;
  id: string;
  mime?: string;
  durationSec?: number;
};

type TestConfig = {
  opening: {
    title: { pos: { x: number; y: number }; color: string; fontSize: number };
    countdown: { fontSize: number };
    curtain: { color: string };
  };
  content: {
    mic: { transform: { x: number; y: number; rotation: number } };
    device: {
      transform: { x: number; y: number; scale: number; rotation: number };
      profile?: {
        id: string;
        kind: "phone" | "professional-teleprompter" | "custom";
        aspectRatio: number;
        screen: { x: number; y: number; w: number; h: number };
      };
    };
    layout: {
      preset: "free" | "stage-mic-above-prompter";
      minimumVerticalSeparation: number;
    };
    teleprompter: {
      screen: { x: number; y: number; w: number; h: number };
      text: { fontSize: number };
      video?: { asset: TestAssetRef };
    };
  };
  ending: { video: { asset: TestAssetRef } };
};

type TestResolvedConfig = {
  content: {
    device: { aspectRatio: number };
    teleprompter: { screen: { x: number; y: number; w: number; h: number } };
  };
  ending: { video: { asset: { durationSec?: number } } };
};

type TestConfigValidationIssue = Readonly<{
  path: string;
  message: string;
  code: string;
}>;

type TestConfigValidationError = Error & {
  readonly issues: readonly TestConfigValidationIssue[];
};

const core = (await import(moduleUrl)) as {
  loadCliConfig: (file: string) => Promise<{
    config: TestConfig;
    files: Record<string, { file: string; mime: string }>;
  }>;
  CliConfigValidationError: new (
    issues: readonly TestConfigValidationIssue[],
    options?: { cause?: unknown },
  ) => TestConfigValidationError;
  ProjectConfig: {
    safeParse: (value: unknown) =>
      | { success: true; data: TestConfig }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  };
  makeDefaultConfig: () => TestConfig;
  BUILTIN_ASSETS: Array<{
    id: string;
    publicPath: string;
    mediaType: string;
    defaultSlot: string;
    allowedSlots: readonly string[];
    durationSec?: number;
  }>;
  ASSET_SLOTS: Array<{ id: string; usage: string; mediaType: string }>;
  listBuiltinAssetMetadata: () => Array<{
    id: string;
    type: string;
    usage: string;
    allowedSlots: string[];
    usages: string[];
  }>;
  resolveConfig: (config: TestConfig, urls: Record<string, string>) => TestResolvedConfig;
  builtinAssetFile: (
    runtime: { runtimeSite?: string; sourceRoot?: string },
    publicPath: string,
  ) => string;
};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "video-gen-cli-config-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function rejectsWith(
  promise: Promise<unknown>,
  ...patterns: RegExp[]
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const pattern of patterns) assert.match(error.message, pattern);
    return true;
  });
}

async function captureConfigValidationError(
  promise: Promise<unknown>,
): Promise<TestConfigValidationError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof core.CliConfigValidationError);
    return error;
  }
  return assert.fail("expected CliConfigValidationError");
}

test("default config and built-in asset registry are internally consistent", async () => {
  const result = core.ProjectConfig.safeParse(core.makeDefaultConfig());
  assert.equal(result.success, true);
  assert.equal(core.BUILTIN_ASSETS.length, 6);
  assert.equal(core.ASSET_SLOTS.length, 7);

  const metadata = core.listBuiltinAssetMetadata();
  for (const asset of core.BUILTIN_ASSETS) {
    const stat = await fs.stat(path.join(ROOT, "public", asset.publicPath));
    assert.equal(stat.isFile(), true, `${asset.id} must have a public backing file`);
    const item = metadata.find((candidate) => candidate.id === asset.id);
    assert.equal(item?.type, asset.mediaType);
    assert.ok(item?.usage);
    assert.equal(asset.allowedSlots.includes(asset.defaultSlot), true);
    assert.deepEqual(item?.allowedSlots, [...asset.allowedSlots]);
    assert.equal(item?.usages.length, asset.allowedSlots.length);
  }
});

test("professional device profiles calibrate the screen and enforce stage ordering", () => {
  const config = structuredClone(core.makeDefaultConfig());
  config.content.device.profile = {
    id: "award-stage-prompter-v1",
    kind: "professional-teleprompter",
    aspectRatio: 1461 / 1076,
    screen: { x: 0.196, y: 0.14, w: 0.606, h: 0.314 },
  };
  config.content.layout = {
    preset: "stage-mic-above-prompter",
    minimumVerticalSeparation: 0.05,
  };
  config.content.mic.transform.y = 0.17;
  config.content.device.transform.y = 0.58;

  const parsed = core.ProjectConfig.safeParse(config);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const resolved = core.resolveConfig(parsed.data, {});
  assert.deepEqual(resolved.content.teleprompter.screen, config.content.device.profile.screen);
  assert.equal(
    resolved.content.device.aspectRatio,
    config.content.device.profile.aspectRatio,
  );

  const inverted = structuredClone(config);
  inverted.content.mic.transform.y = 0.7;
  const rejected = core.ProjectConfig.safeParse(inverted);
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    assert.ok(
      rejected.error.issues.some(
        (issue) => issue.path.map(String).join(".") === "content.layout.preset",
      ),
    );
  }

  const phoneProfile = structuredClone(config);
  phoneProfile.content.device.profile!.kind = "phone";
  const wrongDevice = core.ProjectConfig.safeParse(phoneProfile);
  assert.equal(wrongDevice.success, false);
  if (!wrongDevice.success) {
    assert.ok(
      wrongDevice.error.issues.some(
        (issue) =>
          issue.path.map(String).join(".") === "content.device.profile.kind",
      ),
    );
  }
});

test("strict nested schemas reject misspelled fields with their full path", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "config.json");
    await writeJson(file, { opening: { title: { fontSzie: 92 } } });
    await rejectsWith(core.loadCliConfig(file), /opening\.title\.fontSzie/, /未知字段/);
  });
});

test("schema errors expose stable structured issues without changing the message", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "config.json");
    await writeJson(file, { opening: { title: { speeed: 92 } } });

    const error = await captureConfigValidationError(core.loadCliConfig(file));
    assert.equal(error.name, "CliConfigValidationError");
    assert.deepEqual(error.issues, [
      {
        path: "opening.title.speeed",
        message: '未知字段 "speeed"',
        code: "unrecognized_keys",
      },
    ]);
    assert.equal(
      error.message,
      '配置校验失败:\n  - opening.title.speeed: 未知字段 "speeed"',
    );
  });
});

test("LocalFileRef errors carry prefixed paths and one issue per invalid field", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "config.json");
    await writeJson(file, {
      content: {
        background: { kind: "file", path: "", speeed: 1 },
      },
    });

    const error = await captureConfigValidationError(core.loadCliConfig(file));
    assert.deepEqual(
      error.issues.map((issue) => issue.path),
      ["content.background.path", "content.background.speeed"],
    );
    assert.deepEqual(
      error.issues.map((issue) => issue.code),
      ["too_small", "unrecognized_keys"],
    );
    assert.equal(
      error.issues.find((issue) => issue.path.endsWith(".path"))?.message,
      'kind 为 "file" 时 path 不能为空',
    );
    assert.match(error.message, /content\.background\.speeed: 未知字段/);
  });
});

test("layout, color and font bounds cover the editor's valid range", () => {
  const cases: Array<{
    mutate: (config: TestConfig) => void;
    path: string;
  }> = [
    { mutate: (c) => (c.opening.title.pos.x = 1.01), path: "opening.title.pos.x" },
    { mutate: (c) => (c.content.mic.transform.x = -0.11), path: "content.mic.transform.x" },
    { mutate: (c) => (c.content.device.transform.scale = 2.51), path: "content.device.transform.scale" },
    { mutate: (c) => (c.content.device.transform.rotation = 361), path: "content.device.transform.rotation" },
    { mutate: (c) => (c.content.teleprompter.screen.w = 0.95), path: "content.teleprompter.screen.w" },
    { mutate: (c) => (c.opening.curtain.color = "pink"), path: "opening.curtain.color" },
    { mutate: (c) => (c.opening.title.fontSize = 201), path: "opening.title.fontSize" },
    { mutate: (c) => (c.opening.countdown.fontSize = 79), path: "opening.countdown.fontSize" },
    { mutate: (c) => (c.content.teleprompter.text.fontSize = 241), path: "content.teleprompter.text.fontSize" },
    { mutate: (c) => (c.ending.video.asset.durationSec = 0), path: "ending.video.asset.durationSec" },
    { mutate: (c) => (c.ending.video.asset.id = "bad/id"), path: "ending.video.asset.id" },
  ];

  for (const item of cases) {
    const config = structuredClone(core.makeDefaultConfig());
    item.mutate(config);
    const parsed = core.ProjectConfig.safeParse(config);
    assert.equal(parsed.success, false, `${item.path} should be rejected`);
    if (!parsed.success) {
      assert.ok(
        parsed.error.issues.some((issue) => issue.path.map(String).join(".") === item.path),
        `missing issue path ${item.path}`,
      );
    }
  }
});

test("built-in refs must exist and match the target slot media type", async () => {
  await withTempDir(async (dir) => {
    const missing = path.join(dir, "missing.json");
    await writeJson(missing, {
      content: { background: { kind: "builtin", id: "does-not-exist" } },
    });
    await rejectsWith(
      core.loadCliConfig(missing),
      /content\.background\.id/,
      /内置素材 "does-not-exist" 不存在/,
    );

    const wrongType = path.join(dir, "wrong-type.json");
    await writeJson(wrongType, {
      content: { background: { kind: "builtin", id: "open-sfx" } },
    });
    await rejectsWith(
      core.loadCliConfig(wrongType),
      /content\.background\.id/,
      /需要图片素材/,
      /是音频/,
    );
  });
});

test("built-in assets are accepted only in renderer-supported slots", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "unsupported-slot.json");
    await writeJson(file, {
      content: {
        teleprompter: {
          mode: "video",
          video: {
            asset: { kind: "builtin", id: "flowprompter-outro" },
            keepAudio: true,
          },
        },
      },
    });
    await rejectsWith(
      core.loadCliConfig(file),
      /content\.teleprompter\.video\.asset\.id/,
      /flowprompter-outro/,
      /不支持用于/,
      /ending\.video\.asset/,
    );
  });
});

test("built-in video duration is hydrated from the registry and cannot be forged", async () => {
  await withTempDir(async (dir) => {
    const expected = core.BUILTIN_ASSETS.find(
      (asset) => asset.id === "flowprompter-outro",
    )?.durationSec;
    assert.equal(typeof expected, "number");

    const missing = path.join(dir, "missing-duration.json");
    await writeJson(missing, {
      ending: {
        video: {
          asset: { kind: "builtin", id: "flowprompter-outro" },
          keepAudio: true,
        },
      },
    });
    const loaded = await core.loadCliConfig(missing);
    assert.equal(loaded.config.ending.video.asset.durationSec, expected);

    // The resolver remains defensive for older callers that bypass schema
    // parsing and carry stale metadata in memory.
    loaded.config.ending.video.asset.durationSec = 999;
    assert.equal(
      core.resolveConfig(loaded.config, {}).ending.video.asset.durationSec,
      expected,
    );

    const forged = path.join(dir, "forged-duration.json");
    await writeJson(forged, {
      ending: {
        video: {
          asset: {
            kind: "builtin",
            id: "flowprompter-outro",
            durationSec: 999,
          },
        },
      },
    });
    await rejectsWith(
      core.loadCliConfig(forged),
      /ending\.video\.asset\.durationSec/,
      /durationSec 由素材 registry 固定/,
      /不能覆盖为 999/,
    );
  });
});

test("packaged built-in inspection resolves below runtimeSite/public", () => {
  const runtimeSite = path.resolve("/package/runtime/remotion-site");
  assert.equal(
    core.builtinAssetFile(
      { runtimeSite },
      "assets/builtin/flowprompter-outro.mp4",
    ),
    path.join(
      runtimeSite,
      "public",
      "assets",
      "builtin",
      "flowprompter-outro.mp4",
    ),
  );

  const sourceRoot = path.resolve("/checkout/video-gen");
  assert.equal(
    core.builtinAssetFile({ sourceRoot }, "assets/builtin/airport.jpg"),
    path.join(sourceRoot, "public", "assets", "builtin", "airport.jpg"),
  );
  assert.throws(
    () => core.builtinAssetFile({ runtimeSite }, "../runtime.json"),
    /路径越界/,
  );
});

test("CLI rejects upload ids that have no local backing file", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "config.json");
    await writeJson(file, {
      content: {
        background: { kind: "upload", id: "orphan", mime: "image/png" },
      },
    });
    await rejectsWith(
      core.loadCliConfig(file),
      /content\.background/,
      /upload 素材 "orphan" 没有本地文件/,
      /"kind":"file"/,
    );
  });
});

test("relative video refs are resolved and probed with real media metadata", async () => {
  await withTempDir(async (dir) => {
    const mediaDir = path.join(dir, "media");
    const projectDir = path.join(dir, "project");
    await fs.mkdir(mediaDir, { recursive: true });
    const clip = path.join(mediaDir, "clip.mp4");
    await fs.copyFile(
      path.join(ROOT, "public/assets/builtin/flowprompter-outro.mp4"),
      clip,
    );

    const file = path.join(projectDir, "config.json");
    await writeJson(file, {
      content: {
        teleprompter: {
          mode: "video",
          video: {
            asset: { kind: "file", path: "../media/clip.mp4", durationSec: 999 },
            keepAudio: true,
          },
        },
      },
    });

    const loaded = await core.loadCliConfig(file);
    const video = loaded.config.content.teleprompter.video;
    assert.ok(video);
    const asset = video.asset;
    assert.equal(asset.kind, "upload");
    const durationSec = asset.durationSec;
    if (typeof durationSec !== "number") assert.fail("probed video duration is missing");
    assert.ok(Math.abs(durationSec - 2.228) < 0.02);
    const local = loaded.files[asset.id];
    assert.equal(local.file, clip);
    assert.equal(local.mime, "video/mp4");
  });
});

test("file refs are strict and invalid image bytes fail before rendering", async () => {
  await withTempDir(async (dir) => {
    const strictFile = path.join(dir, "strict.json");
    await writeJson(strictFile, {
      content: {
        background: { kind: "file", path: "./missing.png", typo: true },
      },
    });
    await rejectsWith(
      core.loadCliConfig(strictFile),
      /content\.background\.typo/,
      /未知字段/,
    );

    const fakeImage = path.join(dir, "fake.png");
    await fs.writeFile(fakeImage, "this is not a png");
    const imageFile = path.join(dir, "image.json");
    await writeJson(imageFile, {
      content: { background: { kind: "file", path: "./fake.png" } },
    });
    await rejectsWith(
      core.loadCliConfig(imageFile),
      /content\.background/,
      /媒体校验失败/,
      /文件头不是可识别/,
    );
  });
});

test("video validation detects corrupt files and audio disguised as mp4", async () => {
  await withTempDir(async (dir) => {
    const corrupt = path.join(dir, "corrupt.mp4");
    await fs.writeFile(corrupt, "not an mp4");
    const corruptConfig = path.join(dir, "corrupt.json");
    await writeJson(corruptConfig, {
      ending: { video: { asset: { kind: "file", path: "./corrupt.mp4" } } },
    });
    await rejectsWith(
      core.loadCliConfig(corruptConfig),
      /ending\.video\.asset/,
      /媒体校验失败/,
    );

    const disguised = path.join(dir, "disguised.mp4");
    await fs.copyFile(path.join(ROOT, "public/assets/builtin/open-sfx.mp3"), disguised);
    const disguisedConfig = path.join(dir, "disguised.json");
    await writeJson(disguisedConfig, {
      ending: { video: { asset: { kind: "file", path: "./disguised.mp4" } } },
    });
    await rejectsWith(
      core.loadCliConfig(disguisedConfig),
      /ending\.video\.asset/,
      /需要视频文件/,
      /实际媒体内容是音频/,
    );
  });
});
