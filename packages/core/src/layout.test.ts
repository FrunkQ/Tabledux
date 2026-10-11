import { describe, expect, it } from 'vitest';
import { LedRunSchema, nextSeat, overlaysFor, rangesFor, SeatSchema, TableLayoutSchema, type LedRun } from './layout.js';

// Alex's table: 854 LEDs at 144/m as four sides, 273 + 154 + 273 + 154.
const mm = (leds: number) => (leds / 144) * 1000;
const table: LedRun[] = [273, 154, 273, 154].reduce<LedRun[]>((runs, count) => {
  const start = runs.reduce((s, r) => s + r.count, 0);
  runs.push(LedRunSchema.parse({ device: 'table', start, count, lengthMm: mm(count) }));
  return runs;
}, []);

describe('rangesFor', () => {
  it('maps a span inside one side to LEDs', () => {
    expect(rangesFor(table, mm(10), mm(30))).toEqual([{ device: 'table', start: 10, stop: 30 }]);
  });

  it('crosses a corner as one range on the same device', () => {
    expect(rangesFor(table, mm(263), mm(283))).toEqual([{ device: 'table', start: 263, stop: 283 }]);
  });

  it('wraps past zero', () => {
    expect(rangesFor(table, mm(844), mm(10))).toEqual([
      { device: 'table', start: 844, stop: 854 },
      { device: 'table', start: 0, stop: 10 },
    ]);
  });

  it('handles reversed runs and a second controller', () => {
    const runs = [
      LedRunSchema.parse({ device: 'a', start: 0, count: 100, lengthMm: 1000 }),
      LedRunSchema.parse({ device: 'b', start: 0, count: 100, lengthMm: 1000, reversed: true }),
    ];
    expect(rangesFor(runs, 900, 1100)).toEqual([
      { device: 'a', start: 90, stop: 100 },
      { device: 'b', start: 90, stop: 100 },
    ]);
  });

  it('returns nothing without runs', () => {
    expect(rangesFor([], 0, 100)).toEqual([]);
  });
});

describe('nextSeat', () => {
  const seats = ['c', 'a', 'b'].map((id, i) => SeatSchema.parse({ id, fromMm: [300, 100, 200][i], toMm: [350, 150, 250][i] }));

  it('goes round in order and wraps', () => {
    const layout = { seats, turnDirection: 'forward' as const };
    expect(nextSeat(layout, null)?.id).toBe('a');
    expect(nextSeat(layout, 'a')?.id).toBe('b');
    expect(nextSeat(layout, 'c')?.id).toBe('a');
    expect(nextSeat(layout, 'a', -1)?.id).toBe('c');
  });

  it('respects backward direction', () => {
    expect(nextSeat({ seats, turnDirection: 'backward' }, 'b')?.id).toBe('a');
  });
});

describe('overlaysFor', () => {
  const layout = TableLayoutSchema.parse({
    runs: [
      { device: 'a', start: 0, count: 10, lengthMm: 100 },
      { device: 'b', start: 0, count: 10, lengthMm: 100 },
    ],
    seats: [
      { id: 's1', fromMm: 0, toMm: 50, colour: '#ff0000' },
      { id: 's2', fromMm: 150, toMm: 200, colour: '#0000ff' },
    ],
  });

  it('draws nothing when seats are hidden and nobody is highlighted', () => {
    expect(overlaysFor(layout, { seatsShown: false, highlightSeat: null }).size).toBe(0);
  });

  it('draws seat bars per device', () => {
    const o = overlaysFor(layout, { seatsShown: true, highlightSeat: null });
    expect(o.get('a')).toEqual([expect.objectContaining({ start: 0, stop: 5, colour: [255, 0, 0], fx: 0 })]);
    expect(o.get('b')).toEqual([expect.objectContaining({ start: 5, stop: 10, colour: [0, 0, 255] })]);
  });

  it('draws the highlight even with seats hidden, in the highlight style', () => {
    const o = overlaysFor(layout, { seatsShown: false, highlightSeat: 's2' });
    expect(o.has('a')).toBe(false);
    expect(o.get('b')).toEqual([expect.objectContaining({ fx: 2, brightness: 255 })]);
  });
});
