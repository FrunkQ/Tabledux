import type { LedRun } from '../types';

export interface Point {
  x: number;
  y: number;
}

/**
 * Maps millimetres along the table edge to points on a diagram and back.
 * Four runs draw as a rectangle (one run per side, going clockwise from the
 * top-left corner); any other number draws as a circle.
 */
export interface Outline {
  width: number;
  height: number;
  total: number;
  pointAt(mm: number): Point;
  mmAt(p: Point): number;
  /** SVG path data for the whole edge. */
  path: string;
}

const PAD = 40;

export function outlineFor(runs: LedRun[], size = 600): Outline {
  const total = runs.reduce((s, r) => s + r.lengthMm, 0);
  return runs.length === 4 && total > 0 ? rectangle(runs, total, size) : circle(Math.max(total, 1), size);
}

function rectangle(runs: LedRun[], total: number, size: number): Outline {
  const long = Math.max(runs[0].lengthMm, runs[2].lengthMm);
  const short = Math.max(runs[1].lengthMm, runs[3].lengthMm);
  const scale = (size - 2 * PAD) / Math.max(long, short);
  const w = long * scale;
  const h = short * scale;
  const corners: Point[] = [
    { x: PAD, y: PAD },
    { x: PAD + w, y: PAD },
    { x: PAD + w, y: PAD + h },
    { x: PAD, y: PAD + h },
  ];
  const starts: number[] = [];
  runs.reduce((acc, r) => (starts.push(acc), acc + r.lengthMm), 0);

  const pointAt = (mm: number): Point => {
    const m = mod(mm, total);
    let i = 0;
    while (i < 3 && starts[i + 1] <= m) i++;
    const f = (m - starts[i]) / runs[i].lengthMm;
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  };

  const mmAt = (p: Point): number => {
    let best = { d: Infinity, mm: 0 };
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
      const f = clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2, 0, 1);
      const q = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < best.d) best = { d, mm: starts[i] + f * runs[i].lengthMm };
    }
    return mod(best.mm, total);
  };

  const path = `M${corners.map((c) => `${c.x},${c.y}`).join(' L')} Z`;
  return { width: w + 2 * PAD, height: h + 2 * PAD, total, pointAt, mmAt, path };
}

function circle(total: number, size: number): Outline {
  const r = size / 2 - PAD;
  const c = size / 2;
  // 0 mm at the top, going clockwise.
  const pointAt = (mm: number): Point => {
    const a = (mod(mm, total) / total) * 2 * Math.PI - Math.PI / 2;
    return { x: c + r * Math.cos(a), y: c + r * Math.sin(a) };
  };
  const mmAt = (p: Point): number => {
    const a = Math.atan2(p.y - c, p.x - c) + Math.PI / 2;
    return mod((a / (2 * Math.PI)) * total, total);
  };
  const path = `M${c},${c - r} A${r},${r} 0 1 1 ${c - 0.01},${c - r} Z`;
  return { width: size, height: size, total, pointAt, mmAt, path };
}

/** Polyline points along the edge from one mm to another (wrapping past 0 when to < from). */
export function arcPoints(o: Outline, fromMm: number, toMm: number, steps = 48): string {
  const span = mod(toMm - fromMm, o.total) || o.total;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = o.pointAt(fromMm + (span * i) / steps);
    pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Length of a seat's arc, allowing for wrap past 0. */
export function spanMm(total: number, fromMm: number, toMm: number): number {
  return mod(toMm - fromMm, total);
}

export const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
