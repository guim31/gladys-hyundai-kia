import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_TRANSPORTS,
} from '@gladysassistant/integration-sdk';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  buildTransportEntries,
  findBlueprintByDevice,
  identifyDevice,
} from '../src/devices/index.js';
import { simulateLanSession } from '../src/devices/plug.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const gladys = createFakeGladys();
const config = normalizeConfig();

test('every blueprint exposes the required shape', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    assert.equal(typeof bp.key, 'string', 'key must be a string');
    assert.equal(typeof bp.deviceExternalId, 'function', 'deviceExternalId must be a function');
    assert.equal(typeof bp.buildDevice, 'function', 'buildDevice must be a function');
  }
});

test('buildDiscoveredDevices returns one payload per blueprint', () => {
  const devices = buildDiscoveredDevices(gladys, config);
  assert.equal(devices.length, DEVICE_BLUEPRINTS.length);
  for (const device of devices) {
    assert.equal(typeof device.name, 'string');
    assert.ok(device.external_id, 'each device has an external_id');
    assert.ok(Array.isArray(device.features) && device.features.length > 0);
  }
});

test('device external_ids are unique across the catalog', () => {
  const devices = buildDiscoveredDevices(gladys, config);
  const ids = devices.map((d) => d.external_id);
  assert.equal(new Set(ids).size, ids.length, 'no two devices may share an external_id');
});

test('findBlueprintByDevice routes an external_id back to its owner blueprint', () => {
  for (const bp of DEVICE_BLUEPRINTS) {
    const external_id = bp.deviceExternalId(gladys);
    const found = findBlueprintByDevice(gladys, { external_id });
    assert.equal(found, bp);
  }
});

test('findBlueprintByDevice returns undefined for an unknown device', () => {
  const found = findBlueprintByDevice(gladys, { external_id: 'does-not-exist' });
  assert.equal(found, undefined);
});

test('manifest action keys are unique across blueprints', () => {
  const keys = DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {}));
  assert.equal(new Set(keys).size, keys.length, 'no two blueprints may register the same action');
});

test('the camera declares a camera/image feature', () => {
  const cameraBlueprint = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'camera');
  const device = cameraBlueprint.buildDevice(gladys, config);
  const imageFeature = device.features.find((f) => f.category === DEVICE_FEATURE_CATEGORIES.CAMERA);
  assert.ok(imageFeature, 'the camera must carry a camera feature');
  assert.equal(imageFeature.type, DEVICE_FEATURE_TYPES.CAMERA.IMAGE);
  assert.equal(imageFeature.read_only, true);
});

test('onGetImage resolves a base64 JPEG under the 150 KB limit', async () => {
  const cameraBlueprint = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'camera');
  const image = await cameraBlueprint.onGetImage(gladys, {
    device: { external_id: cameraBlueprint.deviceExternalId(gladys) },
    config,
  });
  assert.match(image, /^image\/jpg;base64,/);
  assert.ok(image.length <= 150 * 1024, 'the image must stay under 150 KB');
});

test('buildTransportEntries reports one valid entry per dual-channel device', () => {
  const entries = buildTransportEntries(gladys, config);
  assert.ok(entries.length > 0, 'the demo plug reports its transport');
  const validValues = Object.values(DEVICE_TRANSPORTS);
  for (const entry of entries) {
    assert.ok(entry.external_id, 'each entry targets a device external_id');
    assert.ok(validValues.includes(entry.transport), `invalid transport: ${entry.transport}`);
  }
});

test('the demo plug honors the GLADYS_PREFER_LOCAL preference', () => {
  const local = buildTransportEntries(gladys, normalizeConfig({ GLADYS_PREFER_LOCAL: true }));
  const cloud = buildTransportEntries(gladys, normalizeConfig({ GLADYS_PREFER_LOCAL: false }));
  const plugId = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'plug').deviceExternalId(gladys);
  assert.equal(local.find((e) => e.external_id === plugId).transport, DEVICE_TRANSPORTS.LOCAL);
  assert.equal(cloud.find((e) => e.external_id === plugId).transport, DEVICE_TRANSPORTS.CLOUD);
});

test('nominal transport entries never carry a leftover degraded flag', () => {
  const entries = buildTransportEntries(gladys, config);
  for (const entry of entries) {
    assert.equal(entry.degraded, undefined, 'nominal entries must clear the degraded state');
  }
});

test('the plug reports a degraded cloud fallback when the LAN session is refused', () => {
  const plugId = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'plug').deviceExternalId(gladys);
  simulateLanSession(false);
  try {
    const entries = buildTransportEntries(gladys, normalizeConfig({ GLADYS_PREFER_LOCAL: true }));
    const entry = entries.find((e) => e.external_id === plugId);
    assert.equal(entry.transport, DEVICE_TRANSPORTS.CLOUD, 'falls back to cloud');
    assert.equal(entry.degraded, true, 'the fallback is flagged degraded');
    assert.ok(entry.message.en, 'the reason carries at least the mandatory `en` text');
    assert.ok(entry.message.en.length <= 200, 'tooltip messages are capped at 200 characters');
  } finally {
    simulateLanSession(true);
  }
});

test('identifyDevice signals a device that implements identify', async () => {
  const lightId = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'light').deviceExternalId(gladys);
  const message = await identifyDevice(gladys, lightId, config);
  assert.match(message.en, /signalling/);
  assert.ok(message.fr, 'the message is multi-language');
});

test('identifyDevice explains when the device has no way to signal itself', async () => {
  const weatherId = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'weather-station').deviceExternalId(
    gladys,
  );
  const message = await identifyDevice(gladys, weatherId, config);
  assert.match(message.en, /no way to signal/);
});

test('the test_weather action returns a multi-language message', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ current: { temperature_2m: 21.4, relative_humidity_2m: 55 } }),
  });
  try {
    const weatherStation = DEVICE_BLUEPRINTS.find((bp) => bp.key === 'weather-station');
    const message = await weatherStation.actions.test_weather(gladys, { fields: {}, config });
    assert.match(message.en, /21\.4/);
    assert.match(message.fr, /21\.4/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
