import { describe, expect, it } from 'vitest';
import { outlineFor, spanMm } from './geometry';

const run = (lengthMm: number) => ({ device: 'a', start: 0, count: 10, lengthMm, reversed: false, label: '' });

describe('outlineFor', () => {
  it('draws four runs as a rectangle and maps points back to mm', () => {
    const o = outlineFor([run(1896), run(1069), run(1896), run(1069)]);
    expect(o.total).toBeCloseTo(5930);
    for (const mm of [0, 500, 1896, 2500, 4000, 5500]) {
      expect(o.mmAt(o.pointAt(mm))).toBeCloseTo(mm, 0);
    }
  });

  it('draws other layouts as a circle that also round-trips', () => {
    const o = outlineFor([run(3000)]);
    for (const mm of [10, 750, 1500, 2900]) expect(o.mmAt(o.pointAt(mm))).toBeCloseTo(mm, 0);
  });

  it('measures wrapping spans', () => {
    expect(spanMm(1000, 900, 100)).toBe(200);
  });
});
