import { useEffect, useRef, useState } from 'react';

// Two single-axis charts for a load test: response time (line) and throughput (bars, errors
// stacked on top in the status color). Hover shows a crosshair + tooltip per second.
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.floor(e.contentRect.width))));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const H = 170;
const PAD = { l: 44, r: 12, t: 12, b: 24 };

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
}

function Frame({ width, max, unit, n, children, hover, onMove, onLeave, tooltip }) {
  const iw = width - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const xTicks = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  return (
    <div className="chart-frame" onMouseLeave={onLeave}>
      <svg width={width} height={H} onMouseMove={(e) => onMove(e, iw)} role="img">
        <g transform={`translate(${PAD.l},${PAD.t})`}>
          {ticks.map((t) => (
            <g key={t} transform={`translate(0,${ih - (t / max) * ih})`}>
              <line x2={iw} className="chart-grid" />
              <text x={-8} dy="0.32em" textAnchor="end" className="chart-axis">
                {Number.isInteger(t) ? t : t.toFixed(1)}
                {unit}
              </text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={n <= 1 ? 0 : (i / (n - 1)) * iw} y={ih + 16} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="chart-axis">
              {i}s
            </text>
          ))}
          {children(iw, ih)}
          {hover != null && <line className="chart-cross" x1={n <= 1 ? 0 : (hover / (n - 1)) * iw} x2={n <= 1 ? 0 : (hover / (n - 1)) * iw} y2={ih} />}
        </g>
      </svg>
      {tooltip}
    </div>
  );
}

function useHover(n) {
  const [hover, setHover] = useState(null);
  const onMove = (e, iw) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left - PAD.l;
    setHover(n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round((x / iw) * (n - 1)))));
  };
  return [hover, onMove, () => setHover(null)];
}

function Tooltip({ x, width, rows, title }) {
  const left = Math.min(Math.max(PAD.l + x - 80, 0), width - 170);
  return (
    <div className="chart-tip" style={{ left }}>
      <div className="chart-tip-title">{title}</div>
      {rows.map(([swatch, label, value]) => (
        <div key={label} className="chart-tip-row">
          <span className={`swatch ${swatch}`} />
          <span>{label}</span>
          <b>{value}</b>
        </div>
      ))}
    </div>
  );
}

export function LatencyChart({ timeline }) {
  const [ref, width] = useWidth();
  const n = timeline.length;
  const [hover, onMove, onLeave] = useHover(n);
  const max = niceMax(Math.max(1, ...timeline.map((p) => p.avg || 0)));
  const iwOf = width - PAD.l - PAD.r;
  return (
    <div ref={ref} className="chart">
      <div className="chart-title">Average response time</div>
      <Frame
        width={width}
        max={max}
        unit="ms"
        n={n}
        hover={hover}
        onMove={onMove}
        onLeave={onLeave}
        tooltip={
          hover != null && (
            <Tooltip
              x={n <= 1 ? 0 : (hover / (n - 1)) * iwOf}
              width={width}
              title={`Second ${hover}`}
              rows={[['s-series', 'Avg response', timeline[hover].avg == null ? '—' : `${timeline[hover].avg} ms`]]}
            />
          )
        }
      >
        {(iw, ih) => {
          const pts = timeline.map((p, i) => (p.avg == null ? null : [n <= 1 ? 0 : (i / (n - 1)) * iw, ih - (p.avg / max) * ih]));
          const d = pts.reduce((acc, p, i) => (p ? `${acc}${!pts[i - 1] ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}` : acc), '');
          return (
            <>
              <path d={d} className="chart-line" />
              {hover != null && pts[hover] && <circle cx={pts[hover][0]} cy={pts[hover][1]} r={4} className="chart-dot" />}
            </>
          );
        }}
      </Frame>
    </div>
  );
}

export function ThroughputChart({ timeline }) {
  const [ref, width] = useWidth();
  const n = timeline.length;
  const [hover, onMove, onLeave] = useHover(n);
  const max = niceMax(Math.max(1, ...timeline.map((p) => p.rps)));
  const iwOf = width - PAD.l - PAD.r;
  return (
    <div ref={ref} className="chart">
      <div className="chart-title">
        Requests per second
        <span className="legend">
          <span className="swatch s-series" /> Successful
          <span className="swatch s-bad" /> Failed
        </span>
      </div>
      <Frame
        width={width}
        max={max}
        unit=""
        n={n}
        hover={hover}
        onMove={onMove}
        onLeave={onLeave}
        tooltip={
          hover != null && (
            <Tooltip
              x={n <= 1 ? 0 : (hover / (n - 1)) * iwOf}
              width={width}
              title={`Second ${hover}`}
              rows={[
                ['s-series', 'Successful', timeline[hover].rps - timeline[hover].errors],
                ['s-bad', 'Failed', timeline[hover].errors],
              ]}
            />
          )
        }
      >
        {(iw, ih) => {
          const slot = iw / Math.max(1, n);
          const bw = Math.max(1, Math.min(18, slot - 2));
          return timeline.map((p, i) => {
            const cx = n <= 1 ? 0 : (i / (n - 1)) * iw;
            const ok = p.rps - p.errors;
            const hOk = (ok / max) * ih;
            const hErr = (p.errors / max) * ih;
            const r = Math.min(4, bw / 2);
            return (
              <g key={i} opacity={hover == null || hover === i ? 1 : 0.55}>
                {ok > 0 && <rect x={cx - bw / 2} y={ih - hOk} width={bw} height={hOk} rx={p.errors ? 0 : r} className="chart-bar" />}
                {p.errors > 0 && <rect x={cx - bw / 2} y={ih - hOk - hErr - (ok > 0 ? 2 : 0)} width={bw} height={hErr} rx={r} className="chart-bar bad" />}
              </g>
            );
          });
        }}
      </Frame>
    </div>
  );
}
