import { z } from 'zod';

/** Something that happened, from any input adapter. */
export const TableEventSchema = z.object({
  type: z.string().min(1),
  source: z.string().default('unknown'),
  data: z.record(z.string(), z.unknown()).default({}),
  ts: z.number().optional(),
});
export type TableEvent = z.infer<typeof TableEventSchema> & { ts: number };

/** Something to do. Handlers are registered per action type. */
export const ActionSchema = z.object({
  type: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type Action = z.infer<typeof ActionSchema>;

/**
 * When an event of `when.type` arrives and every key in `when.match`
 * equals the same key in the event's data, run `do` in order.
 * `modes` limits the binding to those modes; empty means any mode.
 */
export const BindingSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  enabled: z.boolean().default(true),
  modes: z.array(z.string()).default([]),
  when: z.object({
    type: z.string().min(1),
    match: z.record(z.string(), z.unknown()).default({}),
  }),
  do: z.array(ActionSchema).min(1),
});
export type Binding = z.infer<typeof BindingSchema>;

export const WledDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  kind: z.literal('wled'),
  url: z.string().min(1),
  /**
   * Segment ids from here up are reserved for overlays (seats, turn
   * highlights); scenes use the ids below. WLED on ESP32 allows 32 segments.
   */
  overlayBase: z.number().int().min(1).max(31).default(10),
});
export type WledDevice = z.infer<typeof WledDeviceSchema>;

/** A Home Assistant instance. Its access token is kept in secrets.json, never here. */
export const HomeAssistantDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  kind: z.literal('homeassistant'),
  url: z.string().min(1),
});
export type HomeAssistantDevice = z.infer<typeof HomeAssistantDeviceSchema>;

export const DeviceSchema = z.discriminatedUnion('kind', [WledDeviceSchema, HomeAssistantDeviceSchema]);
export type Device = z.infer<typeof DeviceSchema>;

/** What one light output should show for a scene: a full captured state, or a preset on the device. */
export const LightTargetSchema = z.union([
  z.object({ state: z.record(z.string(), z.unknown()) }),
  z.object({ preset: z.number().int().nonnegative() }),
]);
export type LightTarget = z.infer<typeof LightTargetSchema>;

export const SceneSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** Keyed by device id. Devices not listed are left alone. */
  lights: z.record(z.string(), LightTargetSchema).default({}),
  /** Any other actions to run when the scene starts, e.g. Home Assistant calls. */
  actions: z.array(ActionSchema).default([]),
});
export type Scene = z.infer<typeof SceneSchema>;

export const DevicesFileSchema = z.object({ devices: z.array(DeviceSchema).default([]) });
export const ScenesFileSchema = z.object({ scenes: z.array(SceneSchema).default([]) });
export const BindingsFileSchema = z.object({ bindings: z.array(BindingSchema).default([]) });
/** Per-device secrets such as access tokens, keyed by device id. Never sent back to clients. */
export const SecretsFileSchema = z.object({
  devices: z.record(z.string(), z.object({ token: z.string().optional() })).default({}),
});
export type Secrets = z.infer<typeof SecretsFileSchema>;
