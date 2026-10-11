import type { Action, Binding, Device, DeviceCatalog, LightTarget, Scene, TableLayout, TableSnapshot } from './types';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string; error?: string }).message ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  devices: () => call<Device[]>('GET', '/api/devices'),
  saveDevices: (d: Device[]) => call<Device[]>('PUT', '/api/devices', d),
  refreshDevices: () => call('POST', '/api/devices/refresh'),
  catalog: (id: string) => call<DeviceCatalog>('GET', `/api/devices/${encodeURIComponent(id)}/catalog`),
  captureDevice: (id: string) => call<LightTarget>('POST', `/api/devices/${encodeURIComponent(id)}/capture`),
  preview: (id: string, t: LightTarget) => call('POST', `/api/devices/${encodeURIComponent(id)}/preview`, t),
  saveToken: (id: string, token: string) => call('PUT', `/api/devices/${encodeURIComponent(id)}/token`, { token }),
  scenes: () => call<Scene[]>('GET', '/api/scenes'),
  saveScenes: (s: Scene[]) => call<Scene[]>('PUT', '/api/scenes', s),
  saveScene: (s: Omit<Scene, 'id'> & { id?: string }) => call<Scene>('POST', '/api/scenes', s),
  captureScene: (name: string) => call<Scene>('POST', '/api/scenes/capture', { name }),
  activateScene: (id: string) => call('POST', `/api/scenes/${encodeURIComponent(id)}/activate`),
  lightsOff: () => call('POST', '/api/lights/off'),
  bindings: () => call<Binding[]>('GET', '/api/bindings'),
  saveBindings: (b: Binding[]) => call<Binding[]>('PUT', '/api/bindings', b),
  layout: () => call<TableLayout>('GET', '/api/layout'),
  saveLayout: (l: TableLayout) => call<TableLayout>('PUT', '/api/layout', l),
  overlays: (o: { seatsShown?: boolean; highlightSeat?: string | null }) => call('POST', '/api/overlays', o),
  runAction: (a: Action) => call('POST', '/api/actions', a),
};

/** Live table state over a websocket that reconnects on its own. */
export function connectState(onState: (s: TableSnapshot) => void, onConnected: (c: boolean) => void): () => void {
  let ws: WebSocket | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => onConnected(true);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'state') onState(msg.state);
    };
    ws.onclose = () => {
      onConnected(false);
      if (!stopped) retry = setTimeout(open, 2000);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    ws?.close();
  };
}
