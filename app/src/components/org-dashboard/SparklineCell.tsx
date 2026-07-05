// SparklineCell — minimal inline SVG sparkline, no axes, no labels.
// Used by ProgramsTable's Health column (60px) and TagGroupCard (full width,
// 40px tall) per DESIGN.md §5/§8.

export function SparklineCell({
  points, width = 60, height = 20, color = 'var(--color-primary)', strokeWidth = 1.5,
}: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const valid = points.filter((v) => typeof v === 'number' && isFinite(v));
  if (valid.length < 2) {
    return <div style={{ width, height }} aria-hidden="true" />;
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const xs = valid.map((_, i) => (i / (valid.length - 1)) * width);
  const ys = valid.map((v) => height - ((v - min) / range) * height * 0.86 - height * 0.07);
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible', flexShrink: 0 }}>
      <path d={path} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
