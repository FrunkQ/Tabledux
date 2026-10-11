import type { LightCatalog, LightDriver, LightInfo, LightTarget, OverlaySegment } from '@tabledux/core';
import { WledClient, type WledState } from './client.js';

/**
 * Keys in WLED's /json/state that describe what's on show. Everything
 * else (nightlight, UDP sync, live/realtime flags, playlist ids…) is
 * device housekeeping we don't want to replay from a saved scene.
 */
const SCENE_STATE_KEYS = ['on', 'bri', 'transition', 'mainseg', 'seg'] as const;

/** Read-only or runtime-only segment fields that WLED rejects or ignores on write. */
const SEGMENT_DROP_KEYS = new Set(['len', 'lc', 'cct']);

export function sceneStateFromWled(state: WledState): WledState {
  const out: WledState = {};
  for (const key of SCENE_STATE_KEYS) {
    if (key in state) out[key] = state[key];
  }
  if (Array.isArray(out.seg)) {
    out.seg = (out.seg as Record<string, unknown>[]).map((seg) =>
      Object.fromEntries(Object.entries(seg).filter(([k]) => !SEGMENT_DROP_KEYS.has(k))),
    );
  }
  return out;
}

type Seg = Record<string, unknown> & { id?: unknown };

/** How long WLED needs to finish loading a preset before we draw overlays over it. */
const PRESET_SETTLE_MS = 250;

export class WledDriver implements LightDriver {
  readonly client: WledClient;
  /** Overlay segment ids we last drew, so stale ones can be removed. */
  private overlayIds = new Set<number>();

  constructor(
    readonly deviceId: string,
    url: string,
    client?: WledClient,
    /** First segment id reserved for overlays. Scene segments must stay below it. */
    readonly overlayBase = 10,
    private settleMs = PRESET_SETTLE_MS,
  ) {
    this.client = client ?? new WledClient(url);
  }

  async describe(): Promise<LightInfo> {
    const [info, presets] = await Promise.all([this.client.info(), this.client.presets().catch(() => [])]);
    return { name: info.name, version: info.ver, ledCount: info.leds?.count ?? 0, presets };
  }

  async catalog(): Promise<LightCatalog> {
    const [effects, palettes] = await Promise.all([this.client.effects(), this.client.palettes()]);
    return { effects, palettes };
  }

  async capture(): Promise<LightTarget> {
    const state = sceneStateFromWled(await this.client.state());
    // Overlays aren't part of the scene.
    if (Array.isArray(state.seg)) state.seg = (state.seg as Seg[]).filter((s) => !this.isOverlayId(s.id));
    return { state };
  }

  async apply(target: LightTarget, overlays: OverlaySegment[] = []): Promise<void> {
    if ('preset' in target) {
      await this.client.setState({ ps: target.preset });
      // A preset replaces every segment, ours included.
      this.overlayIds.clear();
      if (overlays.length) {
        await sleep(this.settleMs);
        await this.setOverlays(overlays);
      }
      return;
    }
    // A scene lists every segment it uses. Any other segment on the device is
    // deleted (WLED deletes a segment when its stop is set to 0), so leftovers
    // from a previous scene don't linger. Overlays go on top in reserved ids.
    const state = { ...target.state };
    const sceneSegs = Array.isArray(state.seg) ? (state.seg as Seg[]).filter((s) => !this.isOverlayId(s.id)) : undefined;
    if (sceneSegs || overlays.length) {
      const segs = [...(sceneSegs ?? []), ...this.overlaySegs(overlays)];
      if (sceneSegs) {
        const used = new Set(segs.map((s) => s.id));
        const current = await this.client.state().catch(() => undefined);
        const existing = Array.isArray(current?.seg) ? (current.seg as Seg[]) : [];
        for (const s of existing) {
          if (typeof s.id === 'number' && !used.has(s.id)) segs.push({ id: s.id, stop: 0 });
        }
      } else {
        segs.push(...this.staleOverlayDeletes(overlays.length));
      }
      state.seg = segs;
    }
    await this.client.setState(state);
    this.overlayIds = new Set(overlays.map((_, i) => this.overlayBase + i));
  }

  async setOverlays(overlays: OverlaySegment[]): Promise<void> {
    const segs = [...this.overlaySegs(overlays), ...this.staleOverlayDeletes(overlays.length)];
    if (segs.length) await this.client.setState({ seg: segs });
    this.overlayIds = new Set(overlays.map((_, i) => this.overlayBase + i));
  }

  private overlaySegs(overlays: OverlaySegment[]): Seg[] {
    return overlays.map((o, i) => ({
      id: this.overlayBase + i,
      start: o.start,
      stop: o.stop,
      on: true,
      bri: o.brightness,
      col: [o.colour, [0, 0, 0], [0, 0, 0]],
      fx: o.fx,
      sx: o.speed,
      ix: o.intensity,
      pal: 0,
    }));
  }

  /** Deletes for overlay ids we drew last time but aren't drawing now. */
  private staleOverlayDeletes(nowCount: number): Seg[] {
    return [...this.overlayIds].filter((id) => id >= this.overlayBase + nowCount).map((id) => ({ id, stop: 0 }));
  }

  private isOverlayId(id: unknown): boolean {
    return typeof id === 'number' && id >= this.overlayBase;
  }

  async off(): Promise<void> {
    await this.client.setState({ on: false });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
