<script lang="ts">
  import { api } from '../api';
  import { live } from '../live.svelte';
  import type { Device, LedRun, Seat, TableLayout } from '../types';
  import { arcPoints, mod, outlineFor, spanMm, type Point } from '../table/geometry';

  const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#ffe119', '#f58231', '#911eb4', '#42d4f4', '#f032e6'];

  let layout = $state<TableLayout | null>(null);
  let devices = $state<Device[]>([]);
  let effects = $state<string[]>([]);
  let error = $state('');
  let status = $state('');
  let sides = $state({ device: '', a: 273, b: 154, c: 273, d: 154, perMetre: 144 });
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  api.layout().then((l) => (layout = l));
  api.devices().then(async (d) => {
    devices = d;
    const wled = d.find((x) => x.kind === 'wled');
    if (wled) {
      const cat = await api.catalog(wled.id).catch(() => null);
      if (cat?.kind === 'wled') effects = cat.effects;
    }
  });

  const wledDevices = $derived(devices.filter((d) => d.kind === 'wled'));
  $effect(() => {
    if (!sides.device && wledDevices[0]) sides.device = wledDevices[0].id;
  });
  const outline = $derived(layout ? outlineFor(layout.runs) : null);
  const highlight = $derived(live.state?.highlightSeat ?? null);
  const origin = $derived(outline ? outline.pointAt(0) : { x: 0, y: 0 });
  const originTip = $derived(outline ? outline.pointAt(Math.min(250, outline.total / 20)) : { x: 0, y: 0 });
  const seatsShown = $derived(live.state?.seatsShown ?? false);

  /** Saves shortly after the last change, so the real table follows edits (and drags) live. */
  function changed() {
    status = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 350);
  }

  async function save() {
    if (!layout) return;
    error = '';
    try {
      await api.saveLayout($state.snapshot(layout));
      status = 'Saved';
    } catch (e) {
      error = (e as Error).message;
      status = '';
    }
  }

  async function overlay(o: { seatsShown?: boolean; highlightSeat?: string | null }) {
    error = '';
    try {
      await api.overlays(o);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function nextSeat(step: number) {
    error = '';
    try {
      await api.runAction({ type: 'seat.next', params: { step } });
    } catch (e) {
      error = (e as Error).message;
    }
  }

  // ── LED runs ───────────────────────────────────────────────

  function fourSides() {
    if (!layout) return;
    const device = sides.device;
    const counts = [sides.a, sides.b, sides.c, sides.d];
    const labels = ['Side 1', 'Side 2', 'Side 3', 'Side 4'];
    let start = 0;
    layout.runs = counts.map((count, i) => {
      const run: LedRun = {
        device,
        start,
        count,
        lengthMm: Math.round((count / sides.perMetre) * 10000) / 10,
        reversed: false,
        label: labels[i],
      };
      start += count;
      return run;
    });
    changed();
  }

  function addRun() {
    if (!layout) return;
    const last = layout.runs.at(-1);
    layout.runs.push({
      device: last?.device ?? wledDevices[0]?.id ?? '',
      start: last ? last.start + last.count : 0,
      count: 60,
      lengthMm: 1000,
      reversed: false,
      label: '',
    });
    changed();
  }

  // ── Seats ──────────────────────────────────────────────────

  function addSeatAt(mm: number) {
    if (!layout || !outline) return;
    const width = Math.min(600, outline.total / 8);
    const ids = new Set(layout.seats.map((s) => s.id));
    let n = 1;
    while (ids.has(`seat-${n}`)) n++;
    const seat: Seat = {
      id: `seat-${n}`,
      name: `Seat ${n}`,
      fromMm: round(mod(mm - width / 2, outline.total)),
      toMm: round(mod(mm + width / 2, outline.total)),
      colour: PALETTE[(n - 1) % PALETTE.length],
      player: '',
    };
    layout.seats.push(seat);
    changed();
    if (!seatsShown) overlay({ seatsShown: true });
  }

  function removeSeat(i: number) {
    layout?.seats.splice(i, 1);
    changed();
  }

  // ── Dragging on the diagram ────────────────────────────────

  let svg = $state<SVGSVGElement>();
  let drag: { seat: number; part: 'from' | 'to' | 'move'; grabMm: number; from: number; to: number } | null = null;

  function svgPoint(e: PointerEvent): Point {
    const m = svg!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  }

  function startDrag(e: PointerEvent, seat: number, part: 'from' | 'to' | 'move') {
    if (!layout || !outline) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const s = layout.seats[seat];
    drag = { seat, part, grabMm: outline.mmAt(svgPoint(e)), from: s.fromMm, to: s.toMm };
  }

  function onMove(e: PointerEvent) {
    if (!drag || !layout || !outline) return;
    const mm = outline.mmAt(svgPoint(e));
    const s = layout.seats[drag.seat];
    if (drag.part === 'move') {
      // Shortest way round from where it was grabbed.
      const delta = mod(mm - drag.grabMm + outline.total / 2, outline.total) - outline.total / 2;
      s.fromMm = round(mod(drag.from + delta, outline.total));
      s.toMm = round(mod(drag.to + delta, outline.total));
    } else if (drag.part === 'from') {
      if (spanMm(outline.total, mm, s.toMm) > 20) s.fromMm = round(mm);
    } else if (spanMm(outline.total, s.fromMm, mm) > 20) {
      s.toMm = round(mm);
    }
    changed();
  }

  function endDrag() {
    drag = null;
  }

  function onTrackClick(e: MouseEvent) {
    if (!outline) return;
    addSeatAt(outline.mmAt(svgPoint(e as PointerEvent)));
  }

  const round = (n: number) => Math.round(n);
  const mid = (s: Seat) => (outline ? outline.pointAt(s.fromMm + spanMm(outline.total, s.fromMm, s.toMm) / 2) : { x: 0, y: 0 });
  /** Pull a label towards the middle of the diagram so it sits inside the edge. */
  const inward = (p: Point, by = 26): Point => {
    if (!outline) return p;
    const cx = outline.width / 2;
    const cy = outline.height / 2;
    const d = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / d) * by, y: p.y + ((cy - p.y) / d) * by };
  };
</script>

{#if layout && outline}
  <div class="stack">
    <section class="panel">
      <div class="row" style="justify-content: space-between">
        <h2 style="margin: 0">Table</h2>
        <span class="small">
          {#if error}<span class="error">{error}</span>{:else}<span class="muted">{status}</span>{/if}
        </span>
      </div>

      {#if layout.runs.length === 0}
        <p class="muted">Describe the LED strip around the table edge first (below), then click the edge to add seats.</p>
      {:else}
        <p class="muted small">Click the edge to add a seat. Drag a seat to move it, or its end dots to resize it.</p>
        <svg
          bind:this={svg}
          viewBox="0 0 {outline.width} {outline.height}"
          class="diagram"
          role="application"
          aria-label="Table diagram"
          onpointermove={onMove}
          onpointerup={endDrag}
          onpointercancel={endDrag}
        >
          <path d={outline.path} class="edge" />
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <path d={outline.path} class="track" onclick={onTrackClick} />
          <circle cx={origin.x} cy={origin.y} r="5" class="origin"><title>Start of the strip (0 mm)</title></circle>
          <line x1={origin.x} y1={origin.y} x2={originTip.x} y2={originTip.y} class="origin-arrow" marker-end="url(#arrow)" />
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
            </marker>
          </defs>

          {#each layout.seats as s, i (s.id)}
            {@const a = outline.pointAt(s.fromMm)}
            {@const b = outline.pointAt(s.toMm)}
            {@const label = inward(mid(s), 55)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <polyline
              points={arcPoints(outline, s.fromMm, s.toMm)}
              class="seat"
              class:hl={highlight === s.id}
              stroke={s.colour}
              onpointerdown={(e) => startDrag(e, i, 'move')}
            />
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <circle cx={a.x} cy={a.y} r="8" class="handle" onpointerdown={(e) => startDrag(e, i, 'from')} />
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <circle cx={b.x} cy={b.y} r="8" class="handle" onpointerdown={(e) => startDrag(e, i, 'to')} />
            <text x={label.x} y={label.y} class="label">{s.name || s.id}</text>
          {/each}
        </svg>
        <div class="row">
          <label class="row"><input type="checkbox" checked={seatsShown} onchange={(e) => overlay({ seatsShown: e.currentTarget.checked })} /> Show seat colours on the table</label>
          <button onclick={() => nextSeat(1)} disabled={layout.seats.length === 0}>Next turn</button>
          <button onclick={() => nextSeat(-1)} disabled={layout.seats.length === 0}>Previous</button>
          <button onclick={() => overlay({ highlightSeat: null })} disabled={!highlight}>Clear highlight</button>
          <label class="row small muted">
            Turns go
            <select bind:value={layout.turnDirection} onchange={changed}>
              <option value="forward">the way the strip runs</option>
              <option value="backward">against the strip</option>
            </select>
          </label>
        </div>
      {/if}
    </section>

    {#if layout.runs.length > 0}
      <section class="panel">
        <h2>Seats</h2>
        {#each layout.seats as s, i (s.id)}
          <div class="row seat-row" class:active={highlight === s.id}>
            <input type="color" bind:value={s.colour} oninput={changed} />
            <input placeholder="Name" bind:value={s.name} oninput={changed} style="flex: 1; min-width: 8rem" />
            <label class="small muted">from <input type="number" min="0" step="10" bind:value={s.fromMm} oninput={changed} class="mm" /></label>
            <label class="small muted">to <input type="number" min="0" step="10" bind:value={s.toMm} oninput={changed} class="mm" /> mm</label>
            <button onclick={() => overlay({ highlightSeat: s.id })}>Highlight</button>
            <button class="danger" onclick={() => removeSeat(i)}>Remove</button>
          </div>
        {:else}
          <p class="muted">No seats yet. Click the table edge above to add one.</p>
        {/each}
      </section>
    {/if}

    <section class="panel">
      <h2>LED strip around the edge</h2>
      <p class="muted small">
        List the strip as runs in order going round the table. Seats are placed in millimetres, so changing the strip later
        keeps them where they are. Total edge: {Math.round(outline.total)} mm.
      </p>
      {#each layout.runs as r, i}
        <div class="row run">
          <input placeholder="Label" bind:value={r.label} oninput={changed} style="width: 7rem" />
          <select bind:value={r.device} onchange={changed}>
            {#each wledDevices as d}<option value={d.id}>{d.name}</option>{/each}
            {#if !wledDevices.some((d) => d.id === r.device)}<option value={r.device}>{r.device || '(pick a device)'}</option>{/if}
          </select>
          <label class="small muted">first LED <input type="number" min="0" bind:value={r.start} oninput={changed} class="num" /></label>
          <label class="small muted">LEDs <input type="number" min="1" bind:value={r.count} oninput={changed} class="num" /></label>
          <label class="small muted">length <input type="number" min="1" bind:value={r.lengthMm} oninput={changed} class="mm" /> mm</label>
          <label class="small muted"><input type="checkbox" bind:checked={r.reversed} onchange={changed} /> reversed</label>
          <button class="danger" onclick={() => (layout!.runs.splice(i, 1), changed())}>Remove</button>
        </div>
      {/each}
      <div class="row" style="margin-top: 0.5rem">
        <button onclick={addRun}>Add run</button>
      </div>

      <details style="margin-top: 1rem">
        <summary class="muted">Quick set-up: a rectangular table with one strip</summary>
        <div class="row" style="margin-top: 0.5rem">
          <select bind:value={sides.device}>
            {#each wledDevices as d}<option value={d.id}>{d.name}</option>{/each}
          </select>
          <label class="small muted">LEDs per side
            <input type="number" bind:value={sides.a} class="num" />
            <input type="number" bind:value={sides.b} class="num" />
            <input type="number" bind:value={sides.c} class="num" />
            <input type="number" bind:value={sides.d} class="num" />
          </label>
          <label class="small muted">LEDs per metre <input type="number" bind:value={sides.perMetre} class="num" /></label>
          <button onclick={fourSides}>Replace runs</button>
        </div>
      </details>
    </section>

    <section class="panel">
      <h2>How overlays look</h2>
      <div class="row">
        <label class="small muted">Seat brightness <input type="range" min="0" max="255" bind:value={layout.style.seatBrightness} onchange={changed} /></label>
        <label class="small muted">Turn brightness <input type="range" min="0" max="255" bind:value={layout.style.highlightBrightness} onchange={changed} /></label>
      </div>
      <div class="row" style="margin-top: 0.5rem">
        <label class="small muted">Turn effect
          {#if effects.length}
            <select bind:value={layout.style.highlightFx} onchange={changed}>
              {#each effects as name, id}<option value={id}>{name}</option>{/each}
            </select>
          {:else}
            <input type="number" min="0" bind:value={layout.style.highlightFx} oninput={changed} class="num" />
          {/if}
        </label>
        <label class="small muted">Speed <input type="range" min="0" max="255" bind:value={layout.style.highlightSpeed} onchange={changed} /></label>
        <label class="small muted">Intensity <input type="range" min="0" max="255" bind:value={layout.style.highlightIntensity} onchange={changed} /></label>
      </div>
    </section>
  </div>
{:else}
  <p class="muted">Loading…</p>
{/if}

<style>
  .diagram { width: 100%; max-height: 60vh; display: block; margin: 0.5rem 0 0.75rem; touch-action: none; user-select: none; }
  .edge { fill: var(--panel-2); stroke: var(--line); stroke-width: 6; }
  .track { fill: none; stroke: transparent; stroke-width: 28; cursor: copy; pointer-events: stroke; }
  .seat { fill: none; stroke-width: 14; stroke-linecap: round; cursor: grab; opacity: 0.85; }
  .seat.hl { stroke-width: 20; opacity: 1; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.45; } }
  .handle { fill: var(--text); stroke: var(--bg); stroke-width: 2; cursor: ew-resize; }
  .label { fill: var(--text); font-size: 15px; text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
  .origin { fill: var(--muted); }
  .origin-arrow { stroke: var(--muted); stroke-width: 2; }
  .num { width: 5rem; }
  label.small { display: inline-flex; gap: 0.4rem; align-items: center; }
  .mm { width: 6rem; }
  .seat-row, .run { padding: 0.35rem 0; border-bottom: 1px solid var(--line); }
  .seat-row.active { border-left: 3px solid var(--accent); padding-left: 0.5rem; }
</style>
