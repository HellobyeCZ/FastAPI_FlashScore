export function Sparkline({
  data,
  width = 200,
  height = 32
}: { data: number[]; width?: number; height?: number }) {
  if (data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / Math.max(1, data.length - 1);
  const points = data
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} role="img" aria-label="sparkline">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1" shapeRendering="crispEdges" />
    </svg>
  );
}
