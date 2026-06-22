/**
 * Brand mark for 小音符起号助手 — an upward eighth note whose head is a play
 * button, set on the product's pink squircle. The play triangle is a gradient
 * "knockout" so it blends seamlessly into the background.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="小音符起号助手"
      className={className}
    >
      <defs>
        <linearGradient id="logo-bg" x1="56" y1="32" x2="456" y2="480" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff7ab6" />
          <stop offset="0.52" stopColor="#ff3d86" />
          <stop offset="1" stopColor="#ec1f74" />
        </linearGradient>
        <radialGradient id="logo-sheen" cx="0.3" cy="0.16" r="0.92">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.38" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="16" y="16" width="480" height="480" rx="120" fill="url(#logo-bg)" />
      <rect x="16" y="16" width="480" height="480" rx="120" fill="url(#logo-sheen)" />
      <rect
        x="16.75"
        y="16.75"
        width="478.5"
        height="478.5"
        rx="119.25"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.20"
        strokeWidth="1.5"
      />

      <g>
        <path d="M300 124 C 384 132 404 206 340 262 C 384 210 366 160 300 180 Z" fill="#ffffff" />
        <rect x="262" y="120" width="44" height="210" rx="22" fill="#ffffff" />
        <circle cx="198" cy="320" r="84" fill="#ffffff" />
      </g>

      <path
        d="M180 290 L180 350 L230 320 Z"
        fill="url(#logo-bg)"
        stroke="url(#logo-bg)"
        strokeWidth="18"
        strokeLinejoin="round"
      />
    </svg>
  );
}
