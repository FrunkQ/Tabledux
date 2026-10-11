import type { FastifyInstance } from 'fastify';
import {
  ActionSchema,
  BindingSchema,
  DeviceSchema,
  LightTargetSchema,
  SceneSchema,
  TableEventSchema,
  TableLayoutSchema,
  slugId,
} from '@tabledux/core';
import { z } from 'zod';
import type { Table } from './table.js';

/**
 * REST API used by the web UI and by anything else that wants to drive
 * the table (StreamDeck, Home Assistant, scripts). Live state is pushed
 * over the /ws websocket; these routes are for reading config and
 * making changes.
 */
export function registerApi(app: FastifyInstance, table: Table): void {
  const { config } = table;

  const parse = <S extends z.ZodType>(schema: S, body: unknown): z.output<S> => {
    const r = schema.safeParse(body);
    if (!r.success) throw badRequest(r.error.message);
    return r.data;
  };

  app.get('/api/state', async () => table.snapshot());

  // Devices
  app.get('/api/devices', async () => config.devices);
  app.put('/api/devices', async (req) => {
    const devices = parse(z.array(DeviceSchema), req.body);
    await config.saveDevices(devices);
    table.rebuildDrivers();
    await table.refreshDevices();
    return config.devices;
  });
  app.post('/api/devices/refresh', async () => {
    await table.refreshDevices();
    return table.snapshot().devices;
  });
  const deviceId = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.get('/api/devices/:id/catalog', async (req) => table.catalog(deviceId(req)));
  app.post('/api/devices/:id/capture', async (req) => table.captureDevice(deviceId(req)));
  app.post('/api/devices/:id/preview', async (req) => {
    await table.preview(deviceId(req), parse(LightTargetSchema, req.body));
    return { ok: true };
  });
  // Write-only: tokens are saved here and never returned by any route.
  app.put('/api/devices/:id/token', async (req) => {
    const id = deviceId(req);
    if (!config.devices.some((d) => d.id === id)) throw notFound(`No device "${id}"`);
    const { token } = parse(z.object({ token: z.string() }), req.body);
    await config.saveToken(id, token.trim());
    table.rebuildDrivers();
    await table.refreshDevices();
    return { ok: true };
  });

  // Scenes
  app.get('/api/scenes', async () => config.scenes);
  app.put('/api/scenes', async (req) => {
    await config.saveScenes(parse(z.array(SceneSchema), req.body));
    return config.scenes;
  });
  // Create or replace one scene (the editor's Save). A new scene without an id gets one from its name.
  app.post('/api/scenes', async (req) => {
    const raw = parse(SceneSchema.partial({ id: true }), req.body);
    const id = raw.id ?? slugId(raw.name, config.scenes.map((s) => s.id));
    const scene = { ...raw, id };
    const exists = config.scenes.some((s) => s.id === id);
    await config.saveScenes(exists ? config.scenes.map((s) => (s.id === id ? scene : s)) : [...config.scenes, scene]);
    return config.scenes.find((s) => s.id === id);
  });
  app.post('/api/scenes/capture', async (req) => {
    const { name, devices } = parse(
      z.object({ name: z.string().min(1), devices: z.array(z.string()).optional() }),
      req.body,
    );
    return table.captureScene(name, devices);
  });
  app.post('/api/scenes/:id/activate', async (req) => {
    await table.activateScene((req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/lights/off', async () => {
    await table.allOff();
    return { ok: true };
  });

  // Table layout: LED runs, seats, overlay style
  app.get('/api/layout', async () => config.layout);
  app.put('/api/layout', async (req) => {
    await table.saveLayout(parse(TableLayoutSchema, req.body));
    return config.layout;
  });
  app.post('/api/overlays', async (req) => {
    const body = parse(
      z.object({ seatsShown: z.boolean().optional(), highlightSeat: z.string().min(1).nullable().optional() }),
      req.body,
    );
    await table.setOverlayState(body);
    return { ok: true };
  });

  // Bindings
  app.get('/api/bindings', async () => config.bindings);
  app.put('/api/bindings', async (req) => {
    const raw = parse(z.array(BindingSchema.partial({ id: true })), req.body);
    const taken: string[] = [];
    const bindings = raw.map((b) => {
      const id = b.id ?? slugId(b.name || b.when.type, [...taken, ...raw.flatMap((x) => (x.id ? [x.id] : []))]);
      taken.push(id);
      return { ...b, id };
    });
    await config.saveBindings(bindings);
    table.engine.setBindings(config.bindings);
    return config.bindings;
  });

  // Events in, from any HTTP client. This is the generic "external trigger" input.
  app.post('/api/events', async (req) => {
    const ev = parse(TableEventSchema, req.body);
    table.bus.emit({ ...ev, source: ev.source === 'unknown' ? 'http' : ev.source });
    return { ok: true };
  });

  // Run one action directly, e.g. a "test" button in the UI.
  app.post('/api/actions', async (req) => {
    const action = parse(ActionSchema, req.body);
    const result = await table.engine.run('manual', action, { type: 'manual', source: 'api', data: {}, ts: Date.now() });
    if (!result.ok) throw badRequest(result.error ?? 'Action failed');
    return result;
  });
}

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function notFound(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 404 });
}
