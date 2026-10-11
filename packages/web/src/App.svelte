<script lang="ts">
  import { live } from './live.svelte';
  import Status from './views/Status.svelte';
  import Scenes from './views/Scenes.svelte';
  import Table from './views/Table.svelte';
  import Bindings from './views/Bindings.svelte';
  import Devices from './views/Devices.svelte';

  const tabs = [
    { id: 'status', label: 'Status', view: Status },
    { id: 'scenes', label: 'Scenes', view: Scenes },
    { id: 'table', label: 'Table', view: Table },
    { id: 'bindings', label: 'Bindings', view: Bindings },
    { id: 'devices', label: 'Devices', view: Devices },
  ] as const;

  let current = $state<string>(location.hash.slice(1) || 'status');
  const View = $derived(tabs.find((t) => t.id === current)?.view ?? Status);

  function go(id: string) {
    current = id;
    history.replaceState(null, '', `#${id}`);
  }

  $effect(() => {
    const onHash = () => (current = location.hash.slice(1) || 'status');
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  });
</script>

<header>
  <strong class="brand">Tabledux</strong>
  <nav>
    {#each tabs as t}
      <button class:active={current === t.id} onclick={() => go(t.id)}>{t.label}</button>
    {/each}
  </nav>
  <span class="conn small" title={live.connected ? 'Connected to the table' : 'Reconnecting…'}>
    <span class="dot" class:on={live.connected}></span>
    {live.state ? `mode: ${live.state.mode}` : ''}
  </span>
</header>

<main>
  <View />
</main>

<style>
  header {
    display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
    padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel);
  }
  .brand { color: var(--accent); font-size: 1.15rem; letter-spacing: 0.02em; }
  nav { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  nav button { background: transparent; border-color: transparent; }
  nav button.active { background: var(--panel-2); border-color: var(--line); }
  .conn { margin-left: auto; display: flex; gap: 0.4rem; align-items: center; color: var(--muted); }
  main { max-width: 960px; margin: 0 auto; padding: 1rem; }
</style>
