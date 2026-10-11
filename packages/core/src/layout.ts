import { z } from 'zod';
import type { OverlaySegment } from './light.js';

/**
 * The physical table edge as an ordered list of LED runs, going round
 * in one direction. Seats and overlays are placed in millimetres along
 * this perimeter, so they survive changing strips or adding a second
 * controller: only the runs need updating.
 */
export const LedRunSchema = z.object({
  device: z.string().min(1),
  /** First LED of this run on its device. */
  start: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  lengthMm: z.number().positive(),
  /** True if the LED numbers count down as you go round (strip fitted the other way). */
  reversed: z.boolean().default(false),
  label: z.string().default(''),
});
export type LedRun = z.infer<typeof LedRunSchema>;

export const SeatSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  /** Start and end along the perimeter in mm. If end < start the seat wraps past 0. */
  fromMm: z.number().nonnegative(),
  toMm: z.number().nonnegative(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
  /** Puck id or player name later; free text for now. */
  player: z.string().default(''),
});
export type Seat = z.infer<typeof SeatSchema>;

/** How overlays look on WLED. fx/sx/ix are WLED effect id, speed and intensity. */
export const OverlayStyleSchema = z.object({
  seatBrightness: z.number().int().min(0).max(255).default(90),
  highlightBrightness: z.number().int().min(0).max(255).default(255),
  highlightFx: z.number().int().nonnegative().default(2), // Breathe
  highlightSpeed: z.number().int().min(0).max(255).default(160),
  highlightIntensity: z.number().int().min(0).max(255).default(128),
});
export type OverlayStyle = z.infer<typeof OverlayStyleSchema>;

export const TableLayoutSchema = z.object({
  runs: z.array(LedRunSchema).default([]),
  seats: z.array(SeatSchema).default([]),
  /** Which way "next seat" goes, relative to the order of the runs. */
  turnDirection: z.enum(['forward', 'backward']).default('forward'),
  style: OverlayStyleSchema.default(() => OverlayStyleSchema.parse({})),
});
export type TableLayout = z.infer<typeof TableLayoutSchema>;

export interface LedRange {
  device: string;
  /** Inclusive first LED, exclusive last, as WLED segments use. */
  start: number;
  stop: number;
}

export function perimeterMm(runs: LedRun[]): number {
  return runs.reduce((sum, r) => sum + r.lengthMm, 0);
}

/** LED ranges (per device) covering the perimeter from `fromMm` to `toMm`, wrapping past 0 if needed. */
export function rangesFor(runs: LedRun[], fromMm: number, toMm: number): LedRange[] {
  const total = perimeterMm(runs);
  if (total <= 0) return [];
  const a = mod(fromMm, total);
  const b = mod(toMm, total);
  const spans: [number, number][] = a <= b ? [[a, b]] : [[a, total], [0, b]];
  const out: LedRange[] = [];
  for (const [lo, hi] of spans) {
    let runStart = 0;
    for (const run of runs) {
      const runEnd = runStart + run.lengthMm;
      const s = Math.max(lo, runStart);
      const e = Math.min(hi, runEnd);
      if (e > s) {
        const perLed = run.lengthMm / run.count;
        let i0 = Math.floor((s - runStart) / perLed + 1e-9);
        let i1 = Math.ceil((e - runStart) / perLed - 1e-9);
        i0 = clamp(i0, 0, run.count);
        i1 = clamp(i1, 0, run.count);
        if (i1 > i0) {
          const [first, last] = run.reversed ? [run.count - i1, run.count - i0] : [i0, i1];
          push(out, { device: run.device, start: run.start + first, stop: run.start + last });
        }
      }
      runStart = runEnd;
    }
  }
  return out;
}

/** Seats in the order turns go round the table, starting from the seat nearest 0 mm. */
export function seatsInTurnOrder(layout: Pick<TableLayout, 'seats' | 'turnDirection'>): Seat[] {
  const sorted = [...layout.seats].sort((x, y) => x.fromMm - y.fromMm);
  return layout.turnDirection === 'forward' ? sorted : sorted.reverse();
}

export function nextSeat(layout: Pick<TableLayout, 'seats' | 'turnDirection'>, currentId: string | null, step = 1): Seat | null {
  const order = seatsInTurnOrder(layout);
  if (order.length === 0) return null;
  const i = order.findIndex((s) => s.id === currentId);
  if (i < 0) return step >= 0 ? order[0] : order[order.length - 1];
  return order[mod(i + step, order.length)];
}

/** What the overlay layer should show right now. */
export interface OverlayState {
  /** Draw every seat's colour bar. */
  seatsShown: boolean;
  /** Seat whose turn it is, drawn in the highlight style whether or not seat bars are shown. */
  highlightSeat: string | null;
}

/**
 * Turns the layout and overlay state into WLED-style overlay segments per
 * device. Later segments draw on top, so the highlight comes last.
 */
export function overlaysFor(layout: TableLayout, state: OverlayState): Map<string, OverlaySegment[]> {
  const out = new Map<string, OverlaySegment[]>();
  const add = (seat: Seat, look: Omit<OverlaySegment, 'start' | 'stop' | 'colour'>) => {
    for (const r of rangesFor(layout.runs, seat.fromMm, seat.toMm)) {
      const list = out.get(r.device) ?? [];
      list.push({ start: r.start, stop: r.stop, colour: hexToRgb(seat.colour), ...look });
      out.set(r.device, list);
    }
  };
  const { style } = layout;
  for (const seat of layout.seats) {
    if (state.seatsShown && seat.id !== state.highlightSeat) {
      add(seat, { brightness: style.seatBrightness, fx: 0, speed: 128, intensity: 128 });
    }
  }
  const hl = layout.seats.find((s) => s.id === state.highlightSeat);
  if (hl) {
    add(hl, { brightness: style.highlightBrightness, fx: style.highlightFx, speed: style.highlightSpeed, intensity: style.highlightIntensity });
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function push(out: LedRange[], r: LedRange) {
  // Join with the previous range when they touch on the same device.
  const prev = out[out.length - 1];
  if (prev && prev.device === r.device && prev.stop === r.start) prev.stop = r.stop;
  else out.push(r);
}

const mod = (n: number, m: number) => ((n % m) + m) % m;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
