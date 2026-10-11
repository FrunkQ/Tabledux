import type { LightTarget } from './schema.js';

export interface LightInfo {
  name: string;
  version: string;
  ledCount: number;
  presets: { id: number; name: string }[];
}

/** Names the editor needs to show a device's options. Index = id used in state. */
export interface LightCatalog {
  effects: string[];
  palettes: string[];
}

/** A foreground block of light drawn over the scene, e.g. a seat's colour. */
export interface OverlaySegment {
  start: number;
  stop: number;
  colour: [number, number, number];
  brightness: number;
  /** Effect id; 0 = solid. Speed and intensity as WLED uses them. */
  fx: number;
  speed: number;
  intensity: number;
}

/** Anything that can show a scene: WLED today, other controllers later. */
export interface LightDriver {
  readonly deviceId: string;
  describe(): Promise<LightInfo>;
  catalog(): Promise<LightCatalog>;
  /** Snapshot of the scene the device shows now (without overlays), suitable for saving. */
  capture(): Promise<LightTarget>;
  /** Shows a scene with the given overlays on top. */
  apply(target: LightTarget, overlays?: OverlaySegment[]): Promise<void>;
  /** Replaces just the overlays, leaving the scene underneath alone. */
  setOverlays(overlays: OverlaySegment[]): Promise<void>;
  off(): Promise<void>;
}
