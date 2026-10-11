# Hyundai / Kia for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration that
follows and controls **Hyundai (Bluelink) and Kia (Kia Connect) cars in
Europe** through the same cloud as the official apps: battery and range,
charging, charge limits, climate, locks, doors and windows, odometer, 12 V
battery.

> **Tested on a Hyundai IONIQ 5 (European account): sign-in and unlocking;
> the rest awaits your feedback.** The cloud protocol is ported from
> [hyundai_kia_connect_api](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api),
> the library of the Home Assistant integration `kia_uvo`, and the tests run on
> car states taken from its test fixtures. Reports from owners are very
> welcome on the Gladys forum.

**Not affiliated with Hyundai Motor Company or Kia Corporation.** Hyundai,
Bluelink, Kia, Kia Connect, IONIQ and EV9 are trademarks of their owners.

## What it does

One Gladys device per car, keyed on its VIN:

- **Electric and plug-in hybrid cars**: battery level, range, charging state,
  plugged in, charging time remaining, AC and DC charge limits (settable),
  start / stop charging.
- **Every car**: climate on / off with a setpoint, lock / unlock, door / trunk /
  hood open, window open, odometer, 12 V battery, ignition; outside
  temperature on the newer cars (CCS2 protocol).
- **Dashboard widget** `vehicle`: battery and range tiles, charging, climate,
  locks and openings, last update, buttons for climate, charging, locks and a
  forced refresh.
- **Scene actions**: `refresh_vehicle` (wakes the car and reads its current
  state, with the battery level and range as outputs) and `start_climate`
  (temperature and duration of its own).

## Prerequisites

- Gladys Assistant 5.1.0 or later.
- A Hyundai Bluelink or Kia Connect account **in Europe**, with the car added
  in the official app. Other regions (North America, Australia, China, India)
  and Genesis are not supported.
- For remote commands (locks, climate, charging), the 4-digit PIN of the
  account.

## Installation

Install **Hyundai / Kia** from the integration store of Gladys, then fill in
the configuration: see [`docs/en.md`](docs/en.md) (French:
[`docs/fr.md`](docs/fr.md)).

## How it works

- **Sign-in**: the OneApp ("CCI") login of the official apps — authorize page,
  RSA-encrypted password, authorization code, CCI token set exchanged for a
  CCS token. The token set is stored in `/data/hyundai-kia.json` (mode 0600)
  and refreshed without the password; a full sign-in only happens when the
  refresh is refused. A legacy 48-character refresh token can be pasted in the
  password field instead. Nothing logs a token, a password or the PIN.
- **Reads**: the state the car last sent to the cloud, every 15, 30 or 60
  minutes (never wakes the car). Forced refreshes wake the car: on request
  (scene action, widget button), or every 2 to 12 hours when chosen, never
  between 10 pm and 6 am.
- **Two protocols**: the original one (`vehicleStatus`, commands without PIN)
  and CCS2 (`Vehicle` tree, commands with a control token from the PIN), chosen
  per car by the cloud's `ccuCCS2ProtocolSupport` flag (any non-zero value
  means CCS2, as in the library; the protocol of each car is logged at
  start-up). The configuration asks for the PIN whatever the protocol: users
  cannot tell which one their car speaks.
- **Commands** are answered at once with a message id; the car carries them out
  later. Their outcome is read from the account's notification records (every
  5 s, 2 minutes at most); a confirmed change is published, a failed one puts
  the real state back.
- **Climate setpoint**: the cloud has no "set temperature" command; the
  setpoint feature is kept by the integration and sent with the next climate
  start.

```
index.js                   SDK wiring only
src/hyundaiKia.js          runtime: discovery, reads, publication, commands
src/bluelink/              cloud client: constants, HTTP, sign-in, vehicle API, errors
src/devices/vehicle.js     car states (both protocols) → Gladys device, states, commands
src/widgets.js             `vehicle` dashboard widget
src/scenes.js              scene actions
src/config.js, src/store.js configuration, /data persistence
test/                      node --test, fixtures in test/fixtures/bluelink/
```

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store .   # store admission checks
```

`test/gladys-rules.test.js` checks every discovered device (electric cars on
both protocols, a plug-in hybrid, a combustion car) against the feature table
of the Gladys core (`test/fixtures/gladys-feature-table.json`). Tests never
touch the network. To run against a real Gladys:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="hyundai-kia" \
DATA_DIR=./data LOG_LEVEL=debug \
npm start
```

## Releasing

Releases are cut by the **Release** workflow (Actions → Release): it bumps the
version in `package.json` and the manifest, moves the `## [Unreleased]` section
of [`CHANGELOG.md`](CHANGELOG.md), tags, builds the multi-arch image to
`ghcr.io/guim31/gladys-hyundai-kia` and publishes the GitHub Release. Never
edit the versions by hand.

> A hand-pushed tag (`git tag vX.Y.Z && git push --tags`) triggers the same
> build and GitHub Release, but does not touch the files: bump `version` in
> `package.json` and in `gladys-assistant-integration.json` (with the
> `docker_image` tag) and commit it **before** tagging.

## Credits

- Started from the official
  [Gladys JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
  and built on [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
- The cloud protocol, the reading of the car states and the test fixtures are
  ported from [hyundai_kia_connect_api](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
  (MIT, Copyright (c) 2021 Fuat Akgun and contributors), see
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
  [bluelinky](https://github.com/Hacksore/bluelinky) (MIT) was read for
  comparison.

## License

Apache-2.0
