// Elite Edge Analytics tactical scope reticle — the official V1 logo mark from
// Brand Board v3. Renders a mil-spec scope with embedded "EER" rectangles and a
// gold gradient stroke. `uid` keeps SVG gradient/filter IDs unique when several
// marks render on the same page; `size` controls render dimensions (default 48).

const G = { m: "#C9A227", l: "#E8C14A", d: "#9A7B1E" } as const;
const BG = "#020810";

const TICKS = Array.from({ length: 36 }, (_, i) => {
  const a = (i * 10 * Math.PI) / 180;
  const major = i % 9 === 0;
  const semi = i % 3 === 0;
  return { a, r2: major ? 38 : semi ? 41 : 42.5, major, semi };
});

const EER: [number, number, number, number][] = [
  [32, 37, 4.5, 26], [32, 37, 14, 4.5], [32, 48, 11, 4], [32, 58.5, 14, 4.5],
  [53.5, 37, 4.5, 26], [53.5, 37, 14, 4.5], [53.5, 48, 11, 4], [53.5, 58.5, 14, 4.5],
];

export function ScopeFull({ uid = "a", size = 48 }: { uid?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Elite Edge Analytics">
      <rect width="100" height="100" fill={BG} />
      <defs>
        <linearGradient id={`gl${uid}`} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={G.d} />
          <stop offset="50%" stopColor={G.m} />
          <stop offset="100%" stopColor={G.l} />
        </linearGradient>
        <radialGradient id={`gr${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={G.m} stopOpacity="0.18" />
          <stop offset="100%" stopColor={G.m} stopOpacity="0" />
        </radialGradient>
        <filter id={`gf${uid}`}>
          <feGaussianBlur stdDeviation="3.5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="50" cy="50" r="50" fill={`url(#gr${uid})`} />
      <circle cx="50" cy="50" r="47" fill="none" stroke={`url(#gl${uid})`} strokeWidth="2.5" />
      <circle cx="50" cy="50" r="43.5" fill="none" stroke={G.m} strokeWidth="0.5" opacity="0.2" />
      <circle cx="50" cy="50" r="37" fill="none" stroke={G.m} strokeWidth="0.35" opacity="0.09" />
      {TICKS.map((t, i) => (
        <line
          key={i}
          x1={50 + 44 * Math.sin(t.a)}
          y1={50 - 44 * Math.cos(t.a)}
          x2={50 + t.r2 * Math.sin(t.a)}
          y2={50 - t.r2 * Math.cos(t.a)}
          stroke={G.m}
          strokeWidth={t.major ? 1.4 : 0.65}
          opacity={t.major ? 0.68 : t.semi ? 0.32 : 0.14}
        />
      ))}
      <line x1="6" y1="50" x2="30" y2="50" stroke={G.m} strokeWidth="1.3" opacity="0.92" />
      <line x1="70" y1="50" x2="94" y2="50" stroke={G.m} strokeWidth="1.3" opacity="0.92" />
      <line x1="50" y1="6" x2="50" y2="35" stroke={G.m} strokeWidth="1.3" opacity="0.92" />
      <line x1="50" y1="65" x2="50" y2="94" stroke={G.m} strokeWidth="1.3" opacity="0.92" />
      <circle cx="14" cy="50" r="2" fill={G.m} opacity="0.92" />
      <circle cx="21" cy="50" r="1.4" fill={G.m} opacity="0.6" />
      <circle cx="79" cy="50" r="1.4" fill={G.m} opacity="0.6" />
      <circle cx="86" cy="50" r="2" fill={G.m} opacity="0.92" />
      <line x1="47" y1="14" x2="53" y2="14" stroke={G.m} strokeWidth="0.9" opacity="0.55" />
      <line x1="48" y1="21" x2="52" y2="21" stroke={G.m} strokeWidth="0.6" opacity="0.32" />
      <line x1="48" y1="79" x2="52" y2="79" stroke={G.m} strokeWidth="0.6" opacity="0.32" />
      <line x1="47" y1="86" x2="53" y2="86" stroke={G.m} strokeWidth="0.9" opacity="0.55" />
      <g filter={`url(#gf${uid})`} opacity="0.22">
        {EER.map(([x, y, w, h], i) => (
          <rect key={i} x={x} y={y} width={w} height={h} fill={G.l} />
        ))}
      </g>
      {EER.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={`url(#gl${uid})`} />
      ))}
    </svg>
  );
}
