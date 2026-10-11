import {
  BindingsEngine,
  EventBus,
  nextSeat,
  overlaysFor,
  slugId,
  type ActionResult,
  type LightCatalog,
  type LightDriver,
  type LightTarget,
  type OverlaySegment,
  type Scene,
  type TableEvent,
  type TableLayout,
} from '@tabledux/core';
import { WledDriver } from '@tabledux/wled';
import { HaClient, defaultService, type HaEntity } from '@tabledux/homeassistant';
import type { ConfigStore } from './config-store.js';

export interface DeviceStatus {
  id: string;
  name: string;
  kind: string;
  url: string;
  online: boolean;
  error?: string;
  info?: Awaited<ReturnType<LightDriver['describe']>>;
  /** Home Assistant only: whether a token is saved (the token itself is never sent out). */
  hasToken?: boolean;
}

/** What the scene editor can pick from on one device. */
export type DeviceCatalog =
  | ({ kind: 'wled' } & LightCatalog & { presets: { id: number; name: string }[] })
  | { kind: 'homeassistant'; entities: HaEntity[] };

export interface LogEntry {
  event: TableEvent;
  results: ActionResult[];
}

export interface TableSnapshot {
  mode: string;
  activeSceneId: string | null;
  devices: DeviceStatus[];
  log: LogEntry[];
  actionTypes: string[];
  layout: TableLayout;
  seatsShown: boolean;
  highlightSeat: string | null;
}

const LOG_SIZE = 50;

/** The running table: config, drivers, bindings and live state, wired together. */
export class Table {
  readonly bus: EventBus;
  readonly engine: BindingsEngine;
  private drivers = new Map<string, LightDriver>();
  private ha = new Map<string, HaClient>();
  private status = new Map<string, DeviceStatus>();
  private log: LogEntry[] = [];
  mode = 'idle';
  activeSceneId: string | null = null;
  /** Overlay layer: seat colour bars and the highlighted (active turn) seat. */
  seatsShown = false;
  highlightSeat: string | null = null;
  private listeners = new Set<() => void>();

  constructor(
    readonly config: ConfigStore,
    private logger: { warn: (msg: string) => void; error: (msg: string) => void },
  ) {
    this.bus = new EventBus((err, ev) => logger.error(`Listener failed on ${ev.type}: ${String(err)}`));
    this.engine = new BindingsEngine(() => this.mode);
    this.registerActions();
    this.bus.on((event) => void this.dispatch(event));
  }

  async start(): Promise<void> {
    this.rebuildDrivers();
    this.engine.setBindings(this.config.bindings);
    await this.refreshDevices();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): TableSnapshot {
    return {
      mode: this.mode,
      activeSceneId: this.activeSceneId,
      devices: this.config.devices.map((d) => this.status.get(d.id) ?? { ...d, online: false }),
      log: this.log,
      actionTypes: this.engine.actionTypes(),
      layout: this.config.layout,
      seatsShown: this.seatsShown,
      highlightSeat: this.highlightSeat,
    };
  }

  // ── Devices ────────────────────────────────────────────────

  rebuildDrivers(): void {
    this.drivers.clear();
    this.ha.clear();
    for (const d of this.config.devices) {
      if (d.kind === 'wled') this.drivers.set(d.id, new WledDriver(d.id, d.url, undefined, d.overlayBase));
      if (d.kind === 'homeassistant') this.ha.set(d.id, new HaClient(d.url, this.config.tokenFor(d.id)));
    }
    const ids = new Set(this.config.devices.map((d) => d.id));
    for (const id of [...this.status.keys()]) if (!ids.has(id)) this.status.delete(id);
  }

  async refreshDevices(): Promise<void> {
    await Promise.all(
      this.config.devices.map(async (d) => {
        const base: DeviceStatus = { id: d.id, name: d.name, kind: d.kind, url: d.url, online: false };
        try {
          const driver = this.drivers.get(d.id);
          const ha = this.ha.get(d.id);
          if (driver) this.status.set(d.id, { ...base, online: true, info: await driver.describe() });
          if (ha) {
            base.hasToken = this.config.tokenFor(d.id) !== '';
            await ha.ping();
            this.status.set(d.id, { ...base, online: true });
          }
        } catch (err) {
          this.status.set(d.id, { ...base, online: false, error: (err as Error).message });
        }
      }),
    );
    this.changed();
  }

  async catalog(deviceId: string): Promise<DeviceCatalog> {
    const driver = this.drivers.get(deviceId);
    if (driver) {
      const [cat, info] = await Promise.all([driver.catalog(), driver.describe()]);
      return { kind: 'wled', ...cat, presets: info.presets };
    }
    const ha = this.ha.get(deviceId);
    if (ha) return { kind: 'homeassistant', entities: await ha.entities() };
    throw new Error(`No device "${deviceId}"`);
  }

  /** Shows a look on one device without saving anything: the scene editor's live preview. */
  async preview(deviceId: string, target: LightTarget): Promise<void> {
    const driver = this.drivers.get(deviceId);
    if (!driver) throw new Error(`No light device "${deviceId}"`);
    await driver.apply(target, this.overlays().get(deviceId) ?? []);
  }

  async captureDevice(deviceId: string): Promise<LightTarget> {
    const driver = this.drivers.get(deviceId);
    if (!driver) throw new Error(`No light device "${deviceId}"`);
    return driver.capture();
  }

  // ── Scenes ─────────────────────────────────────────────────

  /** Saves what every online light device is showing right now as a new scene. */
  async captureScene(name: string, deviceIds?: string[]): Promise<Scene> {
    const ids = deviceIds ?? [...this.drivers.keys()];
    const lights: Scene['lights'] = {};
    const failures: string[] = [];
    for (const id of ids) {
      const driver = this.drivers.get(id);
      if (!driver) continue;
      try {
        lights[id] = await driver.capture();
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (Object.keys(lights).length === 0) {
      throw new Error(failures.length ? `Nothing captured. ${failures.join('; ')}` : 'No light devices configured');
    }
    const scene: Scene = {
      id: slugId(name, this.config.scenes.map((s) => s.id)),
      name,
      tags: [],
      lights,
      actions: [],
    };
    await this.config.saveScenes([...this.config.scenes, scene]);
    this.changed();
    return scene;
  }

  async activateScene(id: string): Promise<void> {
    const scene = this.config.scenes.find((s) => s.id === id);
    if (!scene) throw new Error(`No scene "${id}"`);
    const errors: string[] = [];
    const overlays = this.overlays();
    await Promise.all(
      Object.entries(scene.lights).map(async ([deviceId, target]) => {
        const driver = this.drivers.get(deviceId);
        if (!driver) return void errors.push(`device "${deviceId}" is not configured`);
        try {
          await driver.apply(target, overlays.get(deviceId) ?? []);
        } catch (err) {
          errors.push(`${deviceId}: ${(err as Error).message}`);
        }
      }),
    );
    const trigger: TableEvent = { type: 'scene.activated', source: 'scene', data: { scene: id }, ts: Date.now() };
    for (const action of scene.actions) {
      const r = await this.engine.run(`scene:${id}`, action, trigger);
      if (!r.ok) errors.push(`${action.type}: ${r.error}`);
    }
    this.activeSceneId = id;
    this.changed();
    if (errors.length) throw new Error(`Scene "${scene.name}" partly failed: ${errors.join('; ')}`);
  }

  async allOff(): Promise<void> {
    await Promise.all([...this.drivers.values()].map((d) => d.off()));
    this.activeSceneId = null;
    this.changed();
  }

  // ── Layout & overlays ──────────────────────────────────────

  async saveLayout(layout: unknown): Promise<void> {
    await this.config.saveLayout(layout);
    if (this.highlightSeat && !this.config.layout.seats.some((s) => s.id === this.highlightSeat)) {
      this.highlightSeat = null;
    }
    // The layout is saved either way; an offline controller just misses this redraw.
    await this.redrawOverlays().catch((err: Error) => this.logger.warn(err.message));
  }

  async setOverlayState(change: { seatsShown?: boolean; highlightSeat?: string | null }): Promise<void> {
    if (change.highlightSeat && !this.config.layout.seats.some((s) => s.id === change.highlightSeat)) {
      throw new Error(`No seat "${change.highlightSeat}"`);
    }
    if (change.seatsShown !== undefined) this.seatsShown = change.seatsShown;
    if (change.highlightSeat !== undefined) this.highlightSeat = change.highlightSeat;
    await this.redrawOverlays();
  }

  private overlays(): Map<string, OverlaySegment[]> {
    return overlaysFor(this.config.layout, { seatsShown: this.seatsShown, highlightSeat: this.highlightSeat });
  }

  /** Pushes the overlay layer to every light device, leaving their scenes alone. */
  private async redrawOverlays(): Promise<void> {
    const overlays = this.overlays();
    const errors: string[] = [];
    await Promise.all(
      [...this.drivers.entries()].map(async ([id, driver]) => {
        try {
          await driver.setOverlays(overlays.get(id) ?? []);
        } catch (err) {
          errors.push(`${id}: ${(err as Error).message}`);
        }
      }),
    );
    this.changed();
    if (errors.length) throw new Error(`Overlays failed on ${errors.join('; ')}`);
  }

  // ── Events & actions ───────────────────────────────────────

  private registerActions(): void {
    this.engine.registerAction('scene.activate', (p) => this.activateScene(requireString(p, 'scene')));
    this.engine.registerAction('lights.off', () => this.allOff());
    this.engine.registerAction('mode.set', (p) => {
      this.mode = requireString(p, 'mode');
      this.changed();
    });
    this.engine.registerAction('wled.preset', async (p) => {
      const driver = this.drivers.get(requireString(p, 'device'));
      if (!driver) throw new Error(`No device "${String(p.device)}"`);
      const preset = Number(p.preset);
      if (!Number.isInteger(preset) || preset < 1) throw new Error('preset must be a whole number from 1 up');
      await driver.apply({ preset }, this.overlays().get(String(p.device)) ?? []);
    });
    this.engine.registerAction('seats.show', (p) => {
      const show = p.show === 'toggle' ? !this.seatsShown : p.show !== false && p.show !== 'false';
      return this.setOverlayState({ seatsShown: show });
    });
    this.engine.registerAction('seat.highlight', (p) => this.setOverlayState({ highlightSeat: requireString(p, 'seat') }));
    this.engine.registerAction('seat.next', (p) => {
      const step = p.step === undefined || p.step === '' ? 1 : Number(p.step);
      if (!Number.isInteger(step)) throw new Error('step must be a whole number');
      const seat = nextSeat(this.config.layout, this.highlightSeat, step);
      if (!seat) throw new Error('No seats set up');
      return this.setOverlayState({ highlightSeat: seat.id });
    });
    this.engine.registerAction('seat.clear', () => this.setOverlayState({ highlightSeat: null }));
    this.engine.registerAction('ha.call', async (p) => {
      const ha = this.ha.get(requireString(p, 'device'));
      if (!ha) throw new Error(`No Home Assistant device "${String(p.device)}"`);
      const entity = typeof p.entity === 'string' && p.entity ? p.entity : undefined;
      const service = typeof p.service === 'string' && p.service ? p.service : entity ? defaultService(entity) : '';
      if (!service) throw new Error('Needs an entity or a service');
      const data = p.data && typeof p.data === 'object' ? (p.data as Record<string, unknown>) : {};
      await ha.call(service, entity, data);
    });
  }

  private async dispatch(event: TableEvent): Promise<void> {
    const entry: LogEntry = { event, results: [] };
    this.log = [entry, ...this.log].slice(0, LOG_SIZE);
    entry.results = await this.engine.handle(event);
    for (const r of entry.results) {
      if (!r.ok) this.logger.warn(`Binding ${r.bindingId}, action ${r.action.type}: ${r.error}`);
    }
    this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key];
  if (typeof v !== 'string' || v === '') throw new Error(`Missing "${key}"`);
  return v;
}
