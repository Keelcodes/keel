/** Inline SVG marks used across the site. Stroke-only, currentColor, no assets. */

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5 20.5 6v6.6c0 4.9-3.6 8.6-8.5 10.4C7.1 21.2 3.5 17.5 3.5 12.6V6z" />
      <path d="M12 6.5v11.2" />
      <path d="M8 9.5h8" />
    </svg>
  );
}

export type GlyphName = 'shield' | 'union' | 'coins' | 'envelope' | 'anchor' | 'flask';

const PATHS: Record<GlyphName, readonly string[]> = {
  // On-chain enforcement: a hook call admitted or rejected.
  shield: ['M12 3.5l7 3v5.2c0 4.4-3 7.8-7 9.3-4-1.5-7-4.9-7-9.3V6.5z', 'M9 12l2.2 2.2L15.5 10'],
  // Union semantics: overlapping grants.
  union: ['M4.5 6.5h9.5v11H4.5z', 'M10 9h9.5v11H10z'],
  // Per-token ceilings.
  coins: ['M12 8.5c4 0 7-1.3 7-3s-3-3-7-3-7 1.3-7 3 3 3 7 3z', 'M5 5.5v6c0 1.7 3 3 7 3s7-1.3 7-3v-6', 'M5 11.5v6c0 1.7 3 3 7 3s7-1.3 7-3v-6'],
  // ERC-8312 envelope: an aggregate budget around sessions.
  envelope: ['M3.5 6.5h17v11h-17z', 'M3.5 7.5l8.5 6 8.5-6'],
  // Deterministic address on three chains.
  anchor: ['M12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M12 9v11', 'M7 12.5H4a8 8 0 0 0 16 0h-3'],
  // Conformance suite.
  flask: ['M9.5 3.5h5', 'M10.5 3.5v5.2L5.4 18a2 2 0 0 0 1.8 3h9.6a2 2 0 0 0 1.8-3l-5.1-9.3V3.5', 'M8 15h8'],
};

export function Glyph({ name, size = 22 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function ExternalIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}
