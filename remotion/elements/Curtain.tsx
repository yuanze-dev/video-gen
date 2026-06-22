import { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import * as THREE from "three";

/**
 * Physically-flavoured velvet curtain, rendered as a WebGL cloth in a closed-form
 * vertex shader. Every vertex is a PURE FUNCTION of `uProgress` (a frame-driven
 * spring) and `uTime` (frame / fps), so the in-browser <Player> preview and the
 * headless render (chromiumOptions.gl = "angle") stay deterministic and identical.
 *
 * The vertex shader writes CLIP SPACE (NDC) directly and bypasses the camera, so
 * the cloth fills the frame exactly regardless of how the Player scales the canvas.
 * Coordinates: x ∈ [-1,1] (left→right), y ∈ [-1,1] (bottom→top).
 *
 * The fabric GATHERS: as the panel opens it stacks against the outer jamb, the
 * u→x mapping compresses, and the fixed-frequency folds bunch denser toward the
 * stack edge — the cue the old rigid-rectangle slide was missing. Colour stays a
 * runtime uniform; open duration maps to the spring's durationInFrames.
 */

// ---- tunables ------------------------------------------------------------------
const SEG_X = 96; // plane subdivisions across the width — fold smoothness
const SEG_Y = 96; // subdivisions down the height — hem/sway smoothness
const SPRING = { mass: 1, damping: 14, stiffness: 80 } as const;

const vertexShader = /* glsl */ `
  precision highp float;

  uniform float uProgress;  // 0..1 open amount (spring-eased)
  uniform float uTime;      // seconds since the opening started
  uniform float uSide;      // +1 = left panel, -1 = right panel

  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vDepth;     // signed fold depth, for valley occlusion

  const float PI2     = 6.28318530718;
  const float OVERLAP = 0.06;  // how far each panel reaches past centre (NDC)
  const float FOLDS   = 9.0;   // vertical folds per panel
  const float FOLD_AMP= 0.06;  // fold depth (in NDC-x units, drives shading)
  const float MIN_SC  = 0.12;  // panel width when fully stacked (fraction of rest)
  const float PILE_K  = 1.6;   // how strongly folds pile toward the outer edge
  const float SWAY    = 0.03;  // lateral sway amplitude (NDC)
  const float CAT     = 0.10;  // catenary hem droop (NDC-y)
  const float HEM_SW  = 0.04;  // hem swing amplitude (NDC-x)

  // smooth ease-out applied to the gather, on top of the spring
  float gather(float p) { return 1.0 - pow(1.0 - p, 2.0); }

  // Clip-space position of the cloth at parametric (u,v).
  // u: 0 = outer/jamb (stack) edge, 1 = inner/leading edge. v: 0 = top, 1 = hem.
  vec3 cloth(vec2 uv) {
    float u = uv.x;
    float v = uv.y;
    float p = uProgress;
    float g = gather(p);

    float restW  = 1.0 + OVERLAP;           // outer edge -> just past centre
    float outerX = -uSide;                  // anchored at the jamb (±1)
    float widthSc= mix(1.0, MIN_SC, g);     // panel narrows as it stacks
    float uPiled = pow(u, 1.0 + p * PILE_K);// folds densify toward outer edge
    float along  = uPiled * restW * widthSc;
    float x = outerX + uSide * along;
    float y = mix(1.0, -1.0, v);            // top -> bottom

    // folds: fixed frequency in u -> compress in x as widthSc shrinks
    float depth = sin(u * FOLDS * PI2);
    float z = depth * FOLD_AMP * (0.45 + 0.55 * p) * (0.5 + 0.5 * (1.0 - u));

    // secondary motion: sway grows toward the hem and with openness
    float sway = sin(v * 2.0 + uTime * 2.2 + u * 1.3) * SWAY * (0.2 + 0.8 * v) * p;
    x += uSide * sway;

    // catenary hem (cosh via exp, GLSL-ES-1.0 safe) + gentle swing, near the bottom
    float hemF = smoothstep(0.6, 1.0, v);
    float c = (u - 0.5) * 2.0;
    float coshm = (exp(c) + exp(-c)) * 0.5 - 1.0;
    y -= coshm * CAT * hemF * (0.4 + 0.6 * p);
    x += sin(uTime * 1.6 + u * 2.0) * HEM_SW * hemF * p;

    vDepth = depth;
    return vec3(x, y, z);
  }

  void main() {
    float eps = 0.012;
    vec3 pos = cloth(uv);
    vec3 du  = cloth(uv + vec2(eps, 0.0)) - pos;
    vec3 dv  = cloth(uv + vec2(0.0, eps)) - pos;
    vNormal  = normalize(cross(du, dv));
    vUv = uv;
    gl_Position = vec4(pos.x, pos.y, 0.0, 1.0); // NDC directly — no camera
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vDepth;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(vec3(-0.35, 0.45, 0.82)); // key light, upper-front
    vec3 V = vec3(0.0, 0.0, 1.0);

    float ndl = max(dot(N, L), 0.0);
    float lit = pow(ndl * 0.5 + 0.5, 1.3);        // soft velvet wrap

    float facing = clamp(N.z, 0.0, 1.0);
    float ao    = mix(0.5, 1.0, facing);          // fold valleys self-occlude
    float sheen = pow(1.0 - facing, 3.0) * 0.6;   // retro-reflective fold rims

    vec3 R = reflect(-L, N);
    float spec = pow(max(dot(R, V), 0.0), 18.0) * 0.15;

    // a touch darker under the valance (top) and into the deepest valleys
    float topShade = mix(0.78, 1.0, smoothstep(0.0, 0.22, vUv.y));
    float valley   = mix(0.85, 1.0, smoothstep(-1.0, -0.2, vDepth));

    vec3 col = uColor * lit * ao * topShade * valley + uColor * sheen + vec3(spec);
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.7, 0.06, 0.22];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function ClothPanel({
  side,
  color,
  progress,
  time,
}: {
  side: "l" | "r";
  color: string;
  progress: number;
  time: number;
}) {
  // The uniforms object is created once; per-frame values are applied
  // declaratively via R3F "piercing" props so every frame change reconciles
  // onto the material before <ThreeCanvas> advances the GL render.
  const uniforms = useMemo(
    () => ({
      uProgress: { value: 0 },
      uTime: { value: 0 },
      uSide: { value: side === "l" ? 1 : -1 },
      uColor: { value: new THREE.Vector3() },
    }),
    [side],
  );
  const colorVec = useMemo(() => new THREE.Vector3(...hexToRgb(color)), [color]);

  return (
    <mesh>
      <planeGeometry args={[2, 2, SEG_X, SEG_Y]} />
      <shaderMaterial
        uniforms={uniforms}
        uniforms-uProgress-value={progress}
        uniforms-uTime-value={time}
        uniforms-uColor-value={colorVec}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        side={THREE.DoubleSide}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

export function Curtain({
  color,
  startSec,
  openDurationSec,
}: {
  color: string;
  startSec: number;
  openDurationSec: number;
}) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const openFrame = frame - startSec * fps;
  const durationInFrames = Math.max(1, Math.round(openDurationSec * fps));
  const raw = spring({ frame: openFrame, fps, config: SPRING, durationInFrames });
  const progress = Math.min(1, Math.max(0, raw));
  const time = Math.max(0, openFrame) / fps;

  return (
    <AbsoluteFill style={{ zIndex: 6, pointerEvents: "none" }}>
      <ThreeCanvas
        width={width}
        height={height}
        gl={{ alpha: true, antialias: true }}
        style={{ position: "absolute", inset: 0, backgroundColor: "transparent" }}
      >
        <ClothPanel side="l" color={color} progress={progress} time={time} />
        <ClothPanel side="r" color={color} progress={progress} time={time} />
      </ThreeCanvas>

      {/* valance / pelmet — sits above the cloth like a rod cover */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 120,
          background: `linear-gradient(180deg,rgba(255,255,255,.14),rgba(0,0,0,0) 18%,rgba(0,0,0,.32) 100%),${color}`,
          boxShadow: "0 16px 30px rgba(0,0,0,.5)",
          zIndex: 8,
        }}
      />
    </AbsoluteFill>
  );
}
