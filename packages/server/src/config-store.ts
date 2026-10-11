import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BindingsFileSchema,
  DevicesFileSchema,
  ScenesFileSchema,
  SecretsFileSchema,
  TableLayoutSchema,
  type Binding,
  type Device,
  type Scene,
  type Secrets,
  type TableLayout,
} from '@tabledux/core';
import type { z } from 'zod';

/**
 * All user configuration lives as plain JSON files in one data folder,
 * so it can be backed up, diffed and hand-edited. Each file is validated
 * on load; a broken file stops startup with a clear message rather than
 * being silently replaced.
 */
export class ConfigStore {
  devices: Device[] = [];
  scenes: Scene[] = [];
  bindings: Binding[] = [];
  secrets: Secrets = { devices: {} };
  layout: TableLayout = TableLayoutSchema.parse({});

  constructor(readonly dir: string) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.devices = (await this.read('devices.json', DevicesFileSchema, { devices: [] })).devices;
    this.scenes = (await this.read('scenes.json', ScenesFileSchema, { scenes: [] })).scenes;
    this.bindings = (await this.read('bindings.json', BindingsFileSchema, { bindings: [] })).bindings;
    this.layout = await this.read('table.json', TableLayoutSchema, {});
    this.secrets = await this.read('secrets.json', SecretsFileSchema, { devices: {} }, 0o600);
  }

  tokenFor(deviceId: string): string {
    return this.secrets.devices[deviceId]?.token ?? '';
  }

  /** Sets or clears (empty string) a device's token. */
  saveToken(deviceId: string, token: string): Promise<void> {
    const devices = { ...this.secrets.devices };
    if (token) devices[deviceId] = { ...devices[deviceId], token };
    else delete devices[deviceId];
    this.secrets = { devices };
    return this.write('secrets.json', this.secrets, 0o600);
  }

  async saveDevices(devices: Device[]): Promise<void> {
    this.devices = DevicesFileSchema.parse({ devices }).devices;
    await this.write('devices.json', { devices: this.devices });
    // Drop tokens for devices that no longer exist.
    const ids = new Set(this.devices.map((d) => d.id));
    const stale = Object.keys(this.secrets.devices).filter((id) => !ids.has(id));
    for (const id of stale) await this.saveToken(id, '');
  }

  saveScenes(scenes: Scene[]): Promise<void> {
    this.scenes = ScenesFileSchema.parse({ scenes }).scenes;
    return this.write('scenes.json', { scenes: this.scenes });
  }

  saveBindings(bindings: Binding[]): Promise<void> {
    this.bindings = BindingsFileSchema.parse({ bindings }).bindings;
    return this.write('bindings.json', { bindings: this.bindings });
  }

  saveLayout(layout: unknown): Promise<void> {
    this.layout = TableLayoutSchema.parse(layout);
    return this.write('table.json', this.layout);
  }

  private async read<S extends z.ZodType>(
    file: string,
    schema: S,
    fallback: z.input<S>,
    mode?: number,
  ): Promise<z.output<S>> {
    const path = join(this.dir, file);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const value = schema.parse(fallback);
      await this.write(file, value, mode);
      return value;
    }
    const result = schema.safeParse(JSON.parse(text));
    if (!result.success) {
      throw new Error(`${path} is not valid:\n${result.error.message}`);
    }
    return result.data;
  }

  /** Write to a temp file then rename, so a power cut never leaves half a file. */
  private async write(file: string, value: unknown, mode?: number): Promise<void> {
    const path = join(this.dir, file);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode });
    await rename(tmp, path);
  }
}
