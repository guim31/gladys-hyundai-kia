// -----------------------------------------------------------------------------
// Conformity with the Gladys core (mandatory test of this integration series).
//
// Every device the integration discovers from the fixtures — an EV on the
// original protocol, an EV and a plug-in hybrid on CCS2, a combustion car — is
// checked against test/fixtures/gladys-feature-table.json, a table taken from
// the Gladys core code. Do not relax this test to make it pass: fix the
// integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createHyundaiKia } from '../src/hyundaiKia.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { createFakeClient, createMemoryStore } from './helpers/fakeBluelink.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);
const silent = createLogger({ level: 'silent' });

async function discover(configOverrides) {
  const gladys = createFakeGladys();
  const runtime = createHyundaiKia({
    gladys,
    store: createMemoryStore(),
    logger: silent,
    clientFactory: () => createFakeClient(),
  });
  await runtime.start(
    normalizeConfig({ username: 'driver@example.com', password: 'secret', ...configOverrides }),
  );
  await runtime.stop();
  return gladys.discovered;
}

for (const config of [
  { brand: 'hyundai', language: 'en' },
  { brand: 'kia', language: 'fr' },
]) {
  const label = `${config.brand}/${config.language}`;
  const devices = await discover(config);

  test(`[${label}] every car of the fixtures is discovered`, () => {
    assert.deepEqual(devices.map((d) => d.model).sort(), ['EV9', 'IONIQ 5', 'Sportage', 'i30']);
  });

  for (const device of devices) {
    const name = `[${label}] ${device.model} "${device.name}"`;

    test(`${name}: category/type couples exist in Gladys, with labels and icon`, () => {
      for (const feature of device.features) {
        const pair = `${feature.category}/${feature.type}`;
        const entry = table.pairs[pair];
        assert.ok(entry, `${feature.external_id}: ${pair} is not a couple Gladys knows`);
        assert.ok(entry.label_en && entry.label_fr, `${pair} has no label in the Gladys front`);
        assert.ok(entry.icon, `${pair} has no icon in the Gladys front`);
      }
    });

    test(`${name}: should_poll if and only if poll_frequency, in milliseconds`, () => {
      const hasFrequency = device.poll_frequency !== undefined;
      assert.equal(device.should_poll === true, hasFrequency, 'should_poll ⇔ poll_frequency');
      if (hasFrequency) {
        assert.ok(table.poll_frequencies_ms.includes(device.poll_frequency));
      }
    });

    test(`${name}: min/max numbers, boolean flags, known units`, () => {
      for (const feature of device.features) {
        const id = feature.external_id;
        assert.equal(typeof feature.min, 'number', `${id}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${id}: max must be a number`);
        assert.ok(feature.min <= feature.max, `${id}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${id}: read_only`);
        assert.equal(typeof feature.has_feedback, 'boolean', `${id}: has_feedback`);
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${id}: unknown unit ${feature.unit}`);
          const allowed = table.units_by_category[feature.category];
          if (Array.isArray(allowed) && allowed.every((u) => typeof u === 'string')) {
            assert.ok(
              allowed.includes(feature.unit),
              `${id}: unit ${feature.unit} not offered for ${feature.category}`,
            );
          }
        }
      }
    });

    test(`${name}: unique feature external_ids and distinct names`, () => {
      const ids = device.features.map((f) => f.external_id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate feature external_id');
      const names = device.features.map((f) => f.name);
      assert.equal(new Set(names).size, names.length, 'two features share a name');
      for (const id of ids) {
        assert.ok(
          id.startsWith(`${device.external_id}:`),
          `${id} is not under ${device.external_id}`,
        );
      }
    });
  }
}
