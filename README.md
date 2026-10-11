# Tabledux

The table companion to [Mappadux](https://github.com/FrunkQ/dynamic-map-renderer-v2).

Tabledux runs on a Raspberry Pi built into a boardgame/RPG table. It drives the table's LEDs (via WLED) and home automation, and it takes input from hotkeys, RFID cards, per-player one-button "pucks", a touchscreen and phones. Mappadux handles screens and sound. Tabledux handles the table.

- [docs/requirements.md](docs/requirements.md): what the old projects tell us and what Tabledux must do
- [docs/architecture.md](docs/architecture.md): architecture and build order
- [docs/pi-setup.md](docs/pi-setup.md): installing on the Pi

## What works today (steps 1 to 3)

- Add WLED controllers and Home Assistant, and see whether they're online.
- **Scenes:** capture whatever the lights are showing as a named scene, then show it again with one click.
- **Scene editor:** change segments, colours, effects, palettes, speed and brightness with a live preview on the table, or use a WLED preset instead. A scene can cover several controllers, also run Home Assistant scenes/scripts/lights, and have hotkeys assigned from the same screen.
- **Bindings:** "when this happens, do that". Record a hotkey from the table keyboard and bind it to a scene, a WLED preset, all-off or a mode change.
- **Table and seats:** describe the LED strip round the table edge as runs (a quick set-up fills in a rectangular table from LEDs per side), then click the table diagram to add seats and drag them into place. Seats are stored in millimetres along the edge, so re-stripping the table doesn't move them.
- **Overlays:** seat colour bars and a pulsing "whose turn" highlight drawn as extra WLED segments on top of whatever scene is showing. They survive scene changes, and saved scenes never include them. Bind keys to *Seat colours* (show, hide, toggle), *Highlight seat*, *Next turn* (forward or back) and *Clear highlight*.
- **Hotkeys** read straight from the Pi's keyboard, with no window needed.
- **API** for anything else: `POST /api/events` with `{"type":"key.down","data":{"key":"F5"}}`, or any custom event type, triggers bindings the same way.
- A live event log showing every input and what it triggered.

## Developing

```sh
npm install
npm run fake-wled          # a pretend WLED on localhost:8090 if you have no hardware handy
npm run fake-ha            # a pretend Home Assistant on localhost:8123 (token: dev-token)
npm run build && npm start # server + built UI on http://localhost:8080
# or, for UI work with hot reload:
npm run dev                # server (one terminal)
npm run dev:web            # UI on Vite's port, proxied to the server
npm test
```

Layout:

```
packages/core     events, bindings engine, config schemas (no I/O)
packages/wled     WLED JSON API client and light driver
packages/homeassistant  Home Assistant REST client
packages/server   Fastify server, config store, adapters (keyboard), REST + websocket
packages/web      Svelte UI
tools/            fake-wled.mjs, fake-ha.mjs
deploy/           systemd unit
```
