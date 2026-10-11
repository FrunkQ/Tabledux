# Tabledux: architecture proposal (draft 1)

*Companion app to Mappadux. Proposal for review, nothing is built yet. Requirements are in [requirements.md](requirements.md); requirement numbers (R1…R26) refer to it.*

## 1. Shape in one picture

```
 INPUT ADAPTERS                       CORE (on the Pi)                       OUTPUT DRIVERS
 ───────────────                ───────────────────────────────           ───────────────
 Keyboard / hotkeys ─┐          │  Event bus                    │      ┌─► WLED (1..n controllers)
 RFID reader (USB)  ─┤          │     │                         │      │     JSON API + realtime
 Puck hub (USB)     ─┼─events──►│  Bindings engine  ──actions──►├──────┼─► Home Assistant
 Web UI / touchscreen┤          │     │      ▲                  │      │
 HTTP / WebSocket API┤          │  Modes & state machines       │      └─► Mappadux (table role)
 Mappadux link      ─┘          │  (idle, boardgame, rpg, setup)│
                                │  Lighting engine (layers)     │
                                │  Config store (files)         │
                                └───────────────────────────────┘
                                         ▲ websocket (live state)
                                   Web clients: editor, phones, touchscreen
```

Every box on the left and right is a **plug-in behind a small interface**. Nothing in the core knows what a puck or a WLED is. That's how we get configurable systems rather than special cases.

## 2. Core concepts (all data, all editable in the UI)

| Concept | What it is | Example |
|---|---|---|
| **Event** | Something happened. `{type, source, seat?, data, ts}` | `button.press {device:"puck-3", button:"main", kind:"long"}`, `card.present {uid:"FAAF4E08"}`, `key.down {key:"F5"}` |
| **Action** | Something to do. `{type, params}` | `scene.activate {id:"tavern"}`, `game.command {cmd:"endTurn"}`, `mappadux.send {cmd:"initiative.next"}`, `ha.call {service:"scene.turn_on", entity:"scene.dim"}` |
| **Binding** | *When* event matches + context matches, *do* actions. | "In mode `rpg`, any puck short press from the active seat or the GM puck → `mappadux.send initiative.next`." Same rule shape gives "card FAAF… → scene Lava" and "F5 → blackout". |
| **Device** | A configured adapter/driver instance. | `wled-table` at wled-table.local; `wled-ceiling`; `rfid-1` (ACR122U); `puck-hub` on /dev/ttyACM0 |
| **Table geometry** | The physical perimeter as an ordered list of LED runs, each `{device, start, count, length_mm}`. | 854 LEDs as 4 runs, 273/154/273/154. Seats and effects are placed in **mm around the edge**, not LED indices, so adding a second controller or changing strips doesn't touch scenes or games. |
| **Seat** | An arc of the perimeter plus who's there. `{id, from_mm, to_mm, player?, puck?, colour}` | Learned by position detection or set by dragging on a table diagram. |
| **Scene** | Background mood across all outputs. `{name, tags, wled: {device → state or preset}, ha: [actions], mappadux?: cue}` | "Tavern": warm Pacifica on the table, ceiling to 30%, HA `scene.tavern`. |
| **Overlay** | Foreground lighting tied to seats/state, drawn over the scene. | seat colour bars, active-turn pulse, timer fill bar, alert flash, "next player" sweep |
| **Game definition** | Rules as data (evolved from GameTableWLED's `Game.cs`). | Terraforming Mars: 1–5 players, clockwise, pass to end round, round start rotates. |
| **Mode** | Which state machine is running; bindings can be scoped to a mode. | `idle`, `setup` (pairing, seating), `boardgame`, `rpg` |

The **bindings engine** is the heart of "configurable not unique": the GM puck, a hotkey, an RFID card and the touchscreen are all just event sources, and what they do depends on mode and bindings, not on code paths. Sensible default bindings ship with each mode so it works out of the box.

## 3. Lighting engine

Two layers, composed per LED run:
1. **Background** = the active scene. Uses WLED's own effects/presets (cheap, rich, runs on the controller).
2. **Overlays** = seats, turn, timers, alerts. Implemented as **WLED segments** laid over the background segment, set via the JSON API (`/json/state`). That's what GameTableWLED did, minus the hand-numbered segment juggling: the engine allocates segments from the geometry and seats automatically. Segment ids from each WLED device's `overlayBase` (default 10) upward belong to overlays; scenes use the ids below it. WLED draws later segments on top, so overlays sit over the scene, and after a preset recall they are redrawn once the preset has loaded.

Plus a **stream mode** for things WLED effects can't do: Tabledux renders pixels itself and streams them over WLED's realtime **DDP** protocol (UDP 4048). It's used for position detection (exact Gray-code frames) and later for fancy custom effects. WLED drops back to its own state when the stream stops.

Driver interface (sketch):
```ts
interface LightDriver {
  describe(): Promise<{ledCount: number; maxSegments: number; presets: Preset[]}>;
  capture(): Promise<LightState>;          // for "save what's showing now"
  apply(state: LightState): Promise<void>;  // background
  setOverlays(o: OverlaySegment[]): Promise<void>;
  stream?(frame: Uint8Array): void;         // optional realtime
}
```
WLED is the first driver. A **Plasma 2350 W** driver later is just another implementation (it can run WLED-compatible firmware or our own), so that choice doesn't block anything.

## 4. Pucks

- **Hardware track** (parallel, starts after the core works): ESP32-C3 or C6 class board, LiPo, LDR (or a better phototransistor) behind the light pipe, 1–2 buttons, deep sleep with wake on button.
- **Radio: ESP-NOW to a USB "puck hub"** (a spare ESP32 plugged into the Pi). Why: no Wi-Fi join on wake, so a press reaches the table in tens of milliseconds and the puck goes back to sleep at once, which is the best battery life. The hub speaks JSON lines over USB serial to the Puck adapter. BLE is the fallback if ESP-NOW disappoints; the adapter interface hides which.
- **Messages:** `hello {id, fw, battery}`, `press {id, button, kind, seq}`, `locate.result {id, code, quality}`.
- **Position detection, puck-initiated** (pucks sleep, so the table can't call them): long-press in setup mode → puck sends `locate.request` → Tabledux streams a Gray-coded stripe sequence (sync frames + ~8 bits + parity, building on Table2019) → puck samples its LDR in time with the frames and returns the code → Tabledux maps code → mm → seat. A repeat pass or parity bit catches bad reads.
- **Roles:** a puck is either bound to a seat or flagged as the **GM puck**. Bindings decide what each press means.
- **Fallback:** every puck action also exists as a phone button and a hotkey (R11).

## 5. Mappadux link

Mappadux is browser-only and peer-to-peer, with no inbound API. Two facts shape the link:
- Mappadux is served from **https**://mappadux.com, and browsers block calls from an https page to a plain-**http** LAN address (mixed content). That blocks a simple `ws://tabledux.local` connection, and **it probably also stops Stagecraft's WLED calls working from mappadux.com**, which would fit with it never having been tested.
- Mappadux already has guests (players, projectors) joining over WebRTC by room code.

**Recommendation:** add a **"table" guest role** to Mappadux. Tabledux joins the GM's session like a projector does (Node WebRTC via `node-datachannel`, or a headless browser as a fallback). Over that channel:
- Mappadux → Tabledux: `initiative.state {order, active}` (with Mappadux player ↔ seat mapping), `map.loaded {mapId}` (so maps can trigger table scenes), player colours.
- Tabledux → Mappadux: `initiative.next` (from a puck), `scene.request`, later pings/seat events.

Both sides share the message types in a small **`@tabledux/protocol`** package, so Mappadux just imports it.

## 6. Tech stack (defaults, easy to change)

- **TypeScript everywhere**, a monorepo with npm workspaces, the same toolchain as Mappadux (Vite, Vitest).
- **Server:** Node 22 LTS on Raspberry Pi OS (64-bit), Fastify + WebSocket, runs as a systemd service and starts at boot.
- **Web UI:** Vite + Svelte (light and fast on a Pi touchscreen). One app with role-based views: **Editor** (scenes, geometry, seats, bindings, games), **Play** (touchscreen/phone controls), **Status**.
- **Config:** plain JSON files in a data folder, validated with zod schemas, hot-reloaded. Secrets (HA token, etc.) live in a separate `secrets.json` that's never committed. A "backup / restore" export covers the whole data folder.
- **RFID:** `pcsclite` on the Pi with the existing ACR122U reader.
- **Keyboard:** Linux input events (`evdev`), so hotkeys work headless on the Pi 400 without a focused window.
- **Puck firmware:** PlatformIO (Arduino or ESP-IDF) in the same repo under `firmware/`.

```
tabledux/
  packages/
    core/        events, bindings engine, modes, state machines, schemas
    protocol/    shared message types (also used by Mappadux)
    server/      Fastify + WS, config store, device manager
    web/         Svelte UI (editor, play, status)
    adapters/    keyboard, rfid, puck-hub, http, mappadux
    drivers/     wled, home-assistant, (plasma later)
  firmware/
    puck/        ESP32 puck
    hub/         USB ESP-NOW hub
  docs/
```

## 7. Build order

| Step | Delivers | Proves |
|---|---|---|
| **1. Walking skeleton** | Pi service + web UI + WLED driver + keyboard adapter + bindings. Capture the current WLED look as a scene, recall it from a hotkey or the UI. | The core loop works end to end on the Pi 400. |
| **2. Scene editor v1** | Library, live preview, multi-controller, HA actions, assign to hotkey. | R24–26, the UI you wanted. |
| **3. Geometry + seats + overlays** | Table diagram, drag seats, seat colour bars and turn pulse via segments. | Two-layer lighting (R6–8). |
| **4. RFID** | Card → any binding, "tap to assign". | Parity with GameTableWLED; it can be retired here. |
| **5. Boardgame mode** | Game definitions + turn/round state machine + timers, played from phones and hotkeys. | Rules as data (R14–17). |
| **6. Puck v0 on dev boards** | Hub + puck firmware, presses as events, then position detection via DDP. | Hardware track (R9–13). |
| **7. Mappadux link** | Table guest role, initiative highlight, GM puck advances initiative. | RPG integration (R20, 22–23). |
| **8. Touchscreen kiosk + polish** | Kiosk mode on the table display, backups, health page. | Day-to-day use. |

## 8. Decisions I'd like your view on

1. **Mappadux link via a "table" guest role** (recommended) vs. self-hosting Mappadux on the Pi over http so a plain WebSocket works.
2. **Puck radio:** ESP-NOW + USB hub (recommended) vs. BLE straight to the Pi.
3. **UI framework:** Svelte (recommended) vs. matching whatever Mappadux uses (vanilla TS).
4. **Repo:** `FrunkQ/tabledux`, which you'd need to create, since I can't create repos from here.
