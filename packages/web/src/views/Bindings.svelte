<script lang="ts">
  import { api } from '../api';
  import { live } from '../live.svelte';
  import type { Binding, Device, Scene } from '../types';

  let bindings = $state<Binding[]>([]);
  let scenes = $state<Scene[]>([]);
  let devices = $state<Device[]>([]);
  const seats = $derived(live.state?.layout.seats ?? []);
  let dirty = $state(false);
  let error = $state('');
  let saved = $state(false);
  /** Index of the binding waiting for "press a key", and the newest log timestamp when it started. */
  let recording = $state<{ index: number; after: number } | null>(null);

  api.bindings().then((b) => (bindings = b));
  api.scenes().then((s) => (scenes = s));
  api.devices().then((d) => (devices = d));

  const triggerTypes = [
    { type: 'key.down', label: 'Key pressed', field: 'key' },
    { type: 'card.present', label: 'RFID card placed', field: 'uid' },
  ];
  const actionLabels: Record<string, string> = {
    'scene.activate': 'Show scene',
    'lights.off': 'All lights off',
    'wled.preset': 'WLED preset',
    'mode.set': 'Switch mode',
    'ha.call': 'Home Assistant',
    'seats.show': 'Seat colours',
    'seat.highlight': 'Highlight seat',
    'seat.next': 'Next turn',
    'seat.clear': 'Clear highlight',
  };

  // Capture the next key from the live event log while recording.
  $effect(() => {
    const r = recording;
    const latest = live.state?.log[0];
    if (!r || !latest || latest.event.ts <= r.after || latest.event.type !== 'key.down') return;
    const b = bindings[r.index];
    b.when = { type: 'key.down', match: { key: latest.event.data.key } };
    if (!b.name) b.name = `Key ${latest.event.data.key}`;
    recording = null;
    touch();
  });

  function touch() {
    dirty = true;
    saved = false;
  }

  function add() {
    bindings.push({
      name: '',
      enabled: true,
      modes: [],
      when: { type: 'key.down', match: {} },
      do: [{ type: 'scene.activate', params: { scene: scenes[0]?.id ?? '' } }],
    });
    touch();
  }

  function record(index: number) {
    recording = { index, after: live.state?.log[0]?.event.ts ?? 0 };
  }

  function fieldFor(type: string) {
    return triggerTypes.find((t) => t.type === type)?.field ?? 'value';
  }

  async function saveAll() {
    error = '';
    try {
      bindings = await api.saveBindings(bindings);
      dirty = false;
      saved = true;
    } catch (e) {
      error = (e as Error).message;
    }
  }
</script>

<div class="stack">
  <section class="panel">
    <h2>Bindings</h2>
    <p class="muted small">
      A binding says "when this happens, do that". Keys, RFID cards and later puck buttons all work the same way.
    </p>

    {#each bindings as b, i}
      {@const field = fieldFor(b.when.type)}
      <div class="binding" class:off={!b.enabled}>
        <div class="row">
          <input type="checkbox" bind:checked={b.enabled} onchange={touch} title="Enabled" />
          <input placeholder="Name" bind:value={b.name} oninput={touch} style="flex: 1" />
          <button class="danger" onclick={() => (bindings.splice(i, 1), touch())}>Remove</button>
        </div>
        <div class="row">
          <span class="muted">When</span>
          <select bind:value={b.when.type} onchange={() => ((b.when.match = {}), touch())}>
            {#each triggerTypes as t}<option value={t.type}>{t.label}</option>{/each}
          </select>
          <input
            placeholder={field}
            value={String(b.when.match[field] ?? '')}
            oninput={(e) => ((b.when.match = { [field]: e.currentTarget.value }), touch())}
          />
          {#if b.when.type === 'key.down'}
            <button onclick={() => record(i)} disabled={recording !== null}>
              {recording?.index === i ? 'Press a key on the table…' : 'Record key'}
            </button>
          {/if}
        </div>
        {#each b.do as a}
          <div class="row">
            <span class="muted">Do</span>
            <select bind:value={a.type} onchange={() => ((a.params = {}), touch())}>
              {#each live.state?.actionTypes ?? Object.keys(actionLabels) as t}
                <option value={t}>{actionLabels[t] ?? t}</option>
              {/each}
            </select>
            {#if a.type === 'scene.activate'}
              <select bind:value={a.params.scene} onchange={touch}>
                {#each scenes as s}<option value={s.id}>{s.name}</option>{/each}
              </select>
            {:else if a.type === 'wled.preset'}
              <select bind:value={a.params.device} onchange={touch}>
                {#each devices as d}<option value={d.id}>{d.name}</option>{/each}
              </select>
              <input type="number" min="1" placeholder="preset" bind:value={a.params.preset} oninput={touch} style="width: 6rem" />
            {:else if a.type === 'ha.call'}
              <select bind:value={a.params.device} onchange={touch}>
                {#each devices.filter((d) => d.kind === 'homeassistant') as d}<option value={d.id}>{d.name}</option>{/each}
              </select>
              <input placeholder="entity, e.g. scene.tavern" bind:value={a.params.entity} oninput={touch} />
            {:else if a.type === 'seats.show'}
              <select bind:value={a.params.show} onchange={touch}>
                <option value="toggle">toggle</option>
                <option value={true}>show</option>
                <option value={false}>hide</option>
              </select>
            {:else if a.type === 'seat.highlight'}
              <select bind:value={a.params.seat} onchange={touch}>
                {#each seats as s}<option value={s.id}>{s.name || s.id}</option>{/each}
              </select>
            {:else if a.type === 'seat.next'}
              <select bind:value={a.params.step} onchange={touch}>
                <option value={1}>next seat</option>
                <option value={-1}>previous seat</option>
              </select>
            {:else if a.type === 'mode.set'}
              <input placeholder="mode, e.g. idle" bind:value={a.params.mode} oninput={touch} />
            {/if}
            <button title="Run this action now" onclick={() => api.runAction(a).catch((e) => (error = e.message))}>Test</button>
          </div>
        {/each}
      </div>
    {:else}
      <p class="muted">No bindings yet.</p>
    {/each}

    <div class="row" style="margin-top: 0.75rem">
      <button onclick={add}>Add binding</button>
      <button class="primary" onclick={saveAll} disabled={!dirty}>Save</button>
      {#if saved}<span class="muted small">Saved</span>{/if}
      {#if error}<span class="error small">{error}</span>{/if}
    </div>
  </section>
</div>

<style>
  .binding { display: grid; gap: 0.5rem; padding: 0.75rem 0; border-bottom: 1px solid var(--line); }
  .binding.off { opacity: 0.6; }
  .row > .muted:first-child { width: 2.75rem; }
</style>
