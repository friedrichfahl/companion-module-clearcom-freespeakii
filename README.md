# companion-module-clearcom-freespeakii

Bitfocus Companion module for the Clear-Com **Arcadia Central Station** and the **FreeSpeak II base station**
(FSII-BASE-II). It needs **Companion 5.1 or newer** (module API 2.2, Node 22): the presets use layered buttons with gauges.

- User documentation: [HELP.md](./companion/HELP.md)
- License: [LICENSE](./LICENSE)

## How it talks to the devices

Neither device has a published control API. The module uses the same interface as the CCM web UI:

- **REST** (`/api/1/...`, `/api/2/...`, JSON, port 80) for snapshots and commands
- **socket.io 2.x** (Engine.IO v3) for live events:
  - `EndpointUpdated {endpointId, path, value}` for beltpacks and stations
  - `live:<topic>` dirty flags, which trigger a debounced REST refetch

`socket.io-client` is pinned to 2.x on purpose, because newer clients cannot connect to an Engine.IO v3 server.

Both devices speak the same API family, but they differ in places. Each difference lives in a **driver**
(`src/drivers/`). Everything else (state, resolve, actions, feedbacks, variables, presets) is shared.

| Topic             | FreeSpeak II base                               | Arcadia                                                                                    |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Auth              | none                                            | `POST /auth/local/login` → JWT, `POST /auth/refresh`, re-login on 401                      |
| Device info       | `GET /api/1/devices/{id}/liveStatus`            | `GET /api/1/devices/{id}`                                                                  |
| Roles             | `GET /api/1/roles` (keys in `settings.keysets`) | `GET /api/2/rolesets` + `GET /api/2/keysets` (via `sessions[*].data.settings.defaultRole`) |
| Device ↔ role     | `liveStatus.role` (65535 offline), `role.id`    | `liveStatus.association.dpId`                                                              |
| Change role       | `POST …/endpoints/{id}/changerole {id}`         | `POST {endpoint.res}/changeassociation {gid, association:{gid}}`                           |
| Endpoints         | `GET /api/1/devices/{id}/endpoints`             | `GET /api/1/devices/endpoints` (`isGateway` = transceiver)                                 |
| Ports             | `GET …/interfaces/{hw}/ports` for hw 0–4        | `GET /api/1/devices/interfaces/ports`; writes use `port.res`                               |
| `EndpointUpdated` | one object per event                            | array of events; `path: 'liveStatus'` with `{}` = offline                                  |
| GPI polarity      | active-high                                     | active-low; `GpiUpdated {gpiId, path, value}`                                              |
| RSSI field        | `RSSI`                                          | `rssi` (per schema)                                                                        |
| Socket transport  | websocket                                       | polling, upgraded to websocket when possible, Bearer header                                |

Sources:

- the FreeSpeak II driver keeps the request formats of
  [companion-module-clearcom-freespeakii](https://github.com/bitfocus/companion-module-clearcom-freespeakii),
  verified on base firmware 1.6.15
- the Arcadia driver follows [companion-module-clearcom-rest](https://github.com/bitfocus/companion-module-clearcom-rest)
  and the Arcadia's own OpenAPI schema (`GET /api/1/schemas/clearcom_api.json`, Clear-Com API 1.0.1)

The Arcadia driver has been tested against a real Arcadia Central Station on firmware 4.2.83.11-0.

## Layout

| File                                                           | Purpose                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/drivers/driver.ts`                                        | The `DeviceDriver` interface: everything that differs between the devices                   |
| `src/drivers/arcadia.ts`, `fsii.ts`                            | The two drivers (auth, routes, payload normalization)                                       |
| `src/http.ts`                                                  | REST client: parallel reads, serialized writes, 401 → re-login → retry                      |
| `src/socket.ts`                                                | socket.io 2 client: subscriptions, header refresh, reconnects                               |
| `src/state.ts`                                                 | State store that diffs updates, so redundant broadcasts are no-ops                          |
| `src/resolve.ts`                                               | Tolerant accessors for both payload shapes, role → device resolution, tallies               |
| `src/main.ts`                                                  | Lifecycle, event routing, debounced refresh/redraw, heartbeat, reboot detection             |
| `src/actions.ts`, `feedbacks.ts`, `variables.ts`, `presets.ts` | Companion definitions, rebuilt when roles, channels or ports change                         |
| `tools/simulator/`                                             | Arcadia + FreeSpeak II simulator (REST + socket.io 2)                                       |
| `test/`                                                        | Unit tests on real FSII captures, plus end-to-end tests of the module against the simulator |

## Development

```bash
corepack enable
yarn            # install
yarn build      # compile to dist/
yarn dev        # watch mode
yarn lint
yarn test       # unit + end-to-end tests (starts simulators on random ports)
yarn package    # build the distributable package (clearcom-freespeakii-<version>.tgz)
```

To try it in Companion, set the **Developer modules path** (Companion launcher settings) to the **parent
folder** of this repo. Companion runs the module from one of two layouts:

- **Packaged (no Node install needed):** `yarn package` writes the self-contained build to `pkg/` (and the
  `.tgz`). With an empty `DEBUG-PACKAGED` file in the repo root, Companion loads `pkg/` instead of the sources.
  This repo ships with both in place.
- **From source:** delete `DEBUG-PACKAGED`, then run `yarn` and `yarn build` (or `yarn dev`). Companion then runs
  `dist/main.js` with the repo's `node_modules`.

If Companion reports "Module files missing", the chosen layout has not been built yet.

You can also import `clearcom-freespeakii-<version>.tgz` on Companion's Modules page. The module needs
Companion 5.1 or newer (module API 2.2).

### Simulator

Run a fake device and point a Companion connection at it:

```bash
yarn sim:arcadia   # Arcadia on port 8080, login admin / admin, with random talk/call/battery activity
yarn sim:fsii      # FreeSpeak II base on port 8081, replaying real captures
node tools/simulator/simulator.mjs --mode arcadia --port 8080 --password secret --ttl 60 --no-activity
node tools/simulator/simulator.mjs --mode arcadia --firmware 4.2   # payload format of an Arcadia on 4.2.83
```

In Companion, use host `127.0.0.1:8080` (or the simulator machine's IP).
