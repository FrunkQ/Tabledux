import { describe, expect, it } from 'vitest';
import { WledClient, normaliseEndpoint } from './client.js';
import { WledDriver, sceneStateFromWled } from './driver.js';

function fakeFetch(routes: Record<string, unknown>, posted: unknown[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') posted.push(JSON.parse(String(init.body)));
    if (!(path in routes)) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as typeof fetch;
}

describe('normaliseEndpoint', () => {
  it('adds a scheme and strips trailing slashes', () => {
    expect(normaliseEndpoint('wled-table.local/')).toBe('http://wled-table.local');
    expect(normaliseEndpoint('https://x/')).toBe('https://x');
  });
});

describe('sceneStateFromWled', () => {
  it('keeps the look and drops housekeeping', () => {
    const out = sceneStateFromWled({
      on: true,
      bri: 120,
      nl: { on: false },
      udpn: { send: false },
      seg: [{ id: 0, start: 0, stop: 248, len: 248, fx: 9 }],
    });
    expect(out).toEqual({ on: true, bri: 120, seg: [{ id: 0, start: 0, stop: 248, fx: 9 }] });
  });
});

describe('WledDriver', () => {
  it('recalls a preset with ps', async () => {
    const posted: unknown[] = [];
    const d = new WledDriver('t', 'x', new WledClient('x', 1000, fakeFetch({ '/json/state': {} }, posted)));
    await d.apply({ preset: 4 });
    expect(posted).toEqual([{ ps: 4 }]);
  });

  it('turns off segments the scene does not use', async () => {
    const posted: unknown[] = [];
    const current = { seg: [{ id: 0 }, { id: 1 }, { id: 2 }] };
    const d = new WledDriver('t', 'x', new WledClient('x', 1000, fakeFetch({ '/json/state': current }, posted)));
    await d.apply({ state: { on: true, seg: [{ id: 0, fx: 1 }] } });
    expect(posted).toEqual([{ on: true, seg: [{ id: 0, fx: 1 }, { id: 1, stop: 0 }, { id: 2, stop: 0 }] }]);
  });

  it('describes the device, tolerating a missing presets file', async () => {
    const d = new WledDriver(
      't',
      'x',
      new WledClient('x', 1000, fakeFetch({ '/json/info': { name: 'Table', ver: '0.15.0', leds: { count: 854 } } })),
    );
    expect(await d.describe()).toEqual({ name: 'Table', version: '0.15.0', ledCount: 854, presets: [] });
  });

  it('reports HTTP errors', async () => {
    const d = new WledDriver('t', 'x', new WledClient('x', 1000, fakeFetch({})));
    await expect(d.capture()).rejects.toThrow(/HTTP 404/);
  });
});

describe('WledDriver.catalog', () => {
  it('returns effect and palette names', async () => {
    const d = new WledDriver(
      't',
      'x',
      new WledClient('x', 1000, fakeFetch({ '/json/eff': ['Solid', 'Blink'], '/json/pal': ['Default', 'Lava'] })),
    );
    expect(await d.catalog()).toEqual({ effects: ['Solid', 'Blink'], palettes: ['Default', 'Lava'] });
  });
});

describe('WledDriver overlays', () => {
  const overlay = (start: number, stop: number) => ({
    start,
    stop,
    colour: [255, 0, 0] as [number, number, number],
    brightness: 90,
    fx: 0,
    speed: 128,
    intensity: 128,
  });

  it('draws overlays in reserved ids on top of a scene and keeps them out of captures', async () => {
    const posted: Record<string, unknown>[] = [];
    const current = { seg: [{ id: 0 }, { id: 3 }] };
    const d = new WledDriver('t', 'x', new WledClient('x', 1000, fakeFetch({ '/json/state': current }, posted)), 10, 0);
    await d.apply({ state: { seg: [{ id: 0, fx: 1 }] } }, [overlay(5, 10), overlay(20, 25)]);
    const segs = posted[0].seg as { id: number; stop?: number }[];
    expect(segs.map((s) => s.id)).toEqual([0, 10, 11, 3]);
    expect(segs.find((s) => s.id === 3)?.stop).toBe(0);

    const cap = new WledDriver('t', 'x', new WledClient('x', 1000, fakeFetch({ '/json/state': { seg: [{ id: 0 }, { id: 10 }] } })), 10);
    expect(await cap.capture()).toEqual({ state: { seg: [{ id: 0 }] } });
  });

  it('removes overlays it no longer needs', async () => {
    const posted: Record<string, unknown>[] = [];
    const d = new WledDriver('t', 'x', new WledClient('x', 1000, fakeFetch({ '/json/state': {} }, posted)), 10, 0);
    await d.setOverlays([overlay(0, 5), overlay(5, 10), overlay(10, 15)]);
    await d.setOverlays([overlay(0, 5)]);
    await d.setOverlays([]);
    expect((posted[1].seg as { id: number; stop?: number }[]).map((s) => [s.id, s.stop])).toEqual([
      [10, 5],
      [11, 0],
      [12, 0],
    ]);
    expect(posted[2]).toEqual({ seg: [{ id: 10, stop: 0 }] });
  });

  it('redraws overlays after a preset', async () => {
    const posted: Record<string, unknown>[] = [];
    const d = new WledDriver('t', 'x', new WledClient('x', 1000, fakeFetch({ '/json/state': {} }, posted)), 10, 0);
    await d.apply({ preset: 3 }, [overlay(0, 5)]);
    expect(posted[0]).toEqual({ ps: 3 });
    expect((posted[1].seg as { id: number }[])[0].id).toBe(10);
  });
});
