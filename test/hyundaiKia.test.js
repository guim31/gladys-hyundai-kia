import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createHyundaiKia, STATUS_MESSAGES } from '../src/hyundaiKia.js';
import { normalizeConfig } from '../src/config.js';
import { createWidgets } from '../src/widgets.js';
import { createSceneActions } from '../src/scenes.js';
import { VEHICLE_FEATURES as F } from '../src/devices/vehicle.js';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { VEHICLES, createFakeClient, createMemoryStore } from './helpers/fakeBluelink.js';

const silent = createLogger({ level: 'silent' });
const MINUTE = 60 * 1000;
// Local noon and 23:00, whatever the time zone of the test run.
const NOON = new Date(2026, 9, 11, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 9, 11, 23, 0, 0).getTime();
const VIN = Object.fromEntries(VEHICLES.map((v) => [v.vehicleName, v.vin]));

function setup({
  config = {},
  client = createFakeClient(),
  store = createMemoryStore(),
  at = NOON,
} = {}) {
  const gladys = createFakeGladys();
  let clock = at;
  const runtime = createHyundaiKia({
    gladys,
    store,
    logger: silent,
    clientFactory: () => client,
    now: () => clock,
    // Waiting moves the clock: no real delay in the tests.
    wait: async (ms) => {
      clock += ms;
    },
  });
  const cfg = normalizeConfig({ username: 'driver@example.com', password: 'secret', ...config });
  return {
    gladys,
    runtime,
    client,
    store,
    config: cfg,
    advance: (ms) => {
      clock += ms;
    },
    set: (ms) => {
      clock = ms;
    },
    device: (name) => gladys.discovered.find((d) => d.external_id.endsWith(VIN[name])),
    feature: (name, key) => `ext:hyundai-kia:vehicle:${VIN[name]}:${key}`,
  };
}

async function started(options) {
  const ctx = setup(options);
  await ctx.runtime.start(ctx.config);
  return ctx;
}

async function created(options) {
  const ctx = await started(options);
  for (const device of ctx.gladys.createAll()) await ctx.runtime.deviceCreated(device);
  return ctx;
}

test('without credentials: nothing discovered, the status says what to enter', async () => {
  const ctx = setup({ config: { username: '', password: '' } });
  await ctx.runtime.start(ctx.config);
  assert.deepEqual(ctx.gladys.discovered, []);
  assert.deepEqual(ctx.gladys.connectionStatuses.at(-1), {
    connected: false,
    message: STATUS_MESSAGES.notConfigured,
  });
  assert.equal(ctx.client.calls.length, 0);
  await ctx.runtime.stop();
});

test('start: every car discovered from the cached state, none woken', async () => {
  const ctx = await started();
  assert.equal(ctx.gladys.discovered.length, 4);
  assert.equal(ctx.client.count('cachedStatus'), 4);
  assert.equal(ctx.client.count('forcedStatus'), 0);
  assert.equal(ctx.gladys.connectionStatuses.at(-1).connected, true);
  // States of devices not added to Gladys yet are kept for later.
  assert.equal(ctx.gladys.published.length, 0);
  await ctx.runtime.stop();
});

test('a created device gets its states, then only the changes', async () => {
  const ctx = await created();
  assert.equal(ctx.gladys.last(ctx.feature('IONIQ 5', F.BATTERY_LEVEL)), 76);
  assert.equal(ctx.gladys.last(ctx.feature('EV9', F.BATTERY_LEVEL)), 71);
  assert.equal(ctx.gladys.last(ctx.feature('i30', F.RANGE)), 512);
  assert.equal(ctx.gladys.last(ctx.feature('IONIQ 5', F.TARGET_TEMPERATURE)), 21);
  const count = ctx.gladys.published.length;
  // Within the refresh period: no read.
  ctx.advance(10 * MINUTE);
  await ctx.runtime.tick();
  assert.equal(ctx.client.count('cachedStatus'), 4);
  // Past it: read again, nothing changed, nothing published.
  ctx.advance(21 * MINUTE);
  await ctx.runtime.tick();
  assert.equal(ctx.client.count('cachedStatus'), 8);
  assert.equal(ctx.gladys.published.length, count);
  // A change is published.
  ctx.client.states.get(VEHICLES[1].vehicleId).Green.BatteryManagement.BatteryRemain.Ratio = 72;
  ctx.advance(31 * MINUTE);
  await ctx.runtime.tick();
  assert.equal(ctx.gladys.last(ctx.feature('EV9', F.BATTERY_LEVEL)), 72);
  assert.equal(ctx.gladys.published.length, count + 1);
  await ctx.runtime.stop();
});

test('a confirmed command is published, and survives an older cached state', async () => {
  const ctx = await created();
  const ev9 = ctx.device('EV9');
  await ctx.runtime.setValue(ev9, { external_id: ctx.feature('EV9', F.LOCKED) }, 0, {
    deadlineMs: 4000,
  });
  await ctx.runtime.drain();
  assert.equal(ctx.client.count('unlock'), 1);
  assert.equal(ctx.gladys.last(ctx.feature('EV9', F.LOCKED)), 0);
  // The read after the command returned the old "locked" state of the cloud.
  assert.ok(ctx.client.count('cachedStatus') > 4);
  assert.equal(ctx.runtime._vehicles.get(VIN.EV9).snapshot.locked, false);
  await ctx.runtime.stop();
});

test('a failed command puts the real state back', async () => {
  const ctx = await created({ client: createFakeClient({ result: 'failed' }) });
  const ev9 = ctx.device('EV9');
  const id = ctx.feature('EV9', F.LOCKED);
  const before = ctx.gladys.published.filter((p) => p.featureExternalId === id).length;
  await ctx.runtime.setValue(ev9, { external_id: id }, 0);
  await ctx.runtime.drain();
  const after = ctx.gladys.published.filter((p) => p.featureExternalId === id);
  assert.ok(after.length > before, 'the real value is sent again');
  assert.equal(after.at(-1).state, 1);
  await ctx.runtime.stop();
});

test('a command the car never confirms is not counted as done', async () => {
  const ctx = await created({ client: createFakeClient({ result: 'pending' }) });
  const result = await ctx.runtime.order(ctx.device('IONIQ 5').external_id, F.CLIMATE, 1);
  assert.notEqual(result, 'success');
  await ctx.runtime.drain();
  assert.notEqual(ctx.runtime._vehicles.get(VIN['IONIQ 5']).snapshot.climateOn, true);
  await ctx.runtime.stop();
});

test('the climate setpoint is kept locally and sent with the next climate start', async () => {
  const ctx = await created();
  const ioniq = ctx.device('IONIQ 5');
  await ctx.runtime.setValue(
    ioniq,
    { external_id: ctx.feature('IONIQ 5', F.TARGET_TEMPERATURE) },
    23,
  );
  assert.equal(ctx.client.calls.filter((c) => c.name.startsWith('start')).length, 0);
  assert.equal(ctx.store.data.vehicles[VIN['IONIQ 5']].targetTempC, 23);
  assert.equal(ctx.gladys.last(ctx.feature('IONIQ 5', F.TARGET_TEMPERATURE)), 23);
  await ctx.runtime.setValue(ioniq, { external_id: ctx.feature('IONIQ 5', F.CLIMATE) }, 1);
  await ctx.runtime.drain();
  const call = ctx.client.calls.find((c) => c.name === 'startClimate');
  assert.deepEqual(call.args[1], { temperature: 23, duration: 10 });
  assert.equal(ctx.gladys.last(ctx.feature('IONIQ 5', F.CLIMATE)), 1);
  await ctx.runtime.stop();
});

test('a refused sign-in stops every call until the configuration changes', async () => {
  const client = createFakeClient({ fail: { connect: 'auth' } });
  const ctx = await started({ client });
  assert.equal(ctx.runtime.blocked, 'auth');
  assert.deepEqual(ctx.gladys.connectionStatuses.at(-1).message, STATUS_MESSAGES.auth);
  ctx.advance(60 * MINUTE);
  await ctx.runtime.tick();
  assert.equal(client.count('connect'), 1);
  assert.equal(client.count('vehicles'), 0);
  await ctx.runtime.stop();
});

test('reconfiguring with other credentials signs in again', async () => {
  const client = createFakeClient({ fail: { connect: 'auth' } });
  const ctx = await started({ client });
  client.connect = async () => {};
  await ctx.runtime.reconfigure(
    normalizeConfig({ username: 'driver@example.com', password: 'new' }),
  );
  assert.equal(ctx.runtime.blocked, null);
  assert.equal(ctx.gladys.discovered.length, 4);
  await ctx.runtime.stop();
});

test('a spent daily quota pauses the reads for an hour', async () => {
  const client = createFakeClient();
  const ctx = await created({ client });
  const reads = client.count('cachedStatus');
  client.cachedStatus = async () => {
    throw Object.assign(new Error('quota'), { kind: 'rate-limit' });
  };
  ctx.advance(31 * MINUTE);
  await ctx.runtime.tick();
  let calls = 0;
  client.cachedStatus = async () => {
    calls += 1;
    return {};
  };
  ctx.advance(30 * MINUTE);
  await ctx.runtime.tick();
  assert.equal(calls, 0);
  ctx.advance(31 * MINUTE);
  await ctx.runtime.tick();
  assert.ok(calls > 0);
  assert.ok(reads > 0);
  await ctx.runtime.stop();
});

test('forced refreshes: off by default, never at night when chosen', async () => {
  const off = await created();
  off.advance(24 * 60 * MINUTE);
  await off.runtime.tick();
  assert.equal(off.client.count('forcedStatus'), 0);
  await off.runtime.stop();

  const day = await created({ config: { force_refresh_hours: '4' } });
  await day.runtime.tick();
  assert.equal(day.client.count('forcedStatus'), 4);
  day.advance(60 * MINUTE);
  await day.runtime.tick();
  assert.equal(day.client.count('forcedStatus'), 4);
  await day.runtime.stop();

  const night = await created({ config: { force_refresh_hours: '4' }, at: NIGHT });
  await night.runtime.tick();
  assert.equal(night.client.count('forcedStatus'), 0);
  await night.runtime.stop();
});

test('scene actions: forced refresh with outputs, climate with its own settings', async () => {
  const ctx = await created();
  const actions = createSceneActions(ctx.runtime);
  const outputs = await actions.refresh_vehicle({
    fields: { device: ctx.device('EV9').external_id },
  });
  assert.deepEqual(outputs, { battery_level: 71, range_km: 290 });
  assert.equal(ctx.client.count('forcedStatus'), 1);
  const climate = await actions.start_climate({
    fields: { device: ctx.device('IONIQ 5').external_id, temperature: 19, duration: 20 },
  });
  assert.deepEqual(climate, { temperature: 19 });
  assert.deepEqual(ctx.client.calls.find((c) => c.name === 'startClimate').args[1], {
    temperature: 19,
    duration: 20,
  });
  // The dashboard setpoint is left alone.
  assert.equal(ctx.runtime._vehicles.get(VIN['IONIQ 5']).snapshot.targetTempC, 21);
  await assert.rejects(actions.refresh_vehicle({ fields: { device: 'ext:other:1' } }));
  await ctx.runtime.drain();
  await ctx.runtime.stop();
});

test('the vehicle widget fits the core budget for every car, before and after creation', async () => {
  const ctx = await started();
  const widget = createWidgets(ctx.runtime, { timeZone: 'Europe/Paris' }).vehicle;
  for (const name of Object.keys(VIN)) {
    const content = await widget.get({ settings: { device: ctx.device(name).external_id } });
    assert.deepEqual(validateWidgetContent(content), [], name);
    assert.ok(content.components.length <= 8);
    for (const c of content.components) assert.notEqual(c.style, 'primary');
  }
  for (const device of ctx.gladys.createAll()) await ctx.runtime.deviceCreated(device);
  const content = await widget.get({ settings: { device: ctx.device('IONIQ 5').external_id } });
  assert.deepEqual(validateWidgetContent(content), []);
  const tile = content.components.find((c) => c.type === 'value');
  assert.equal(tile.device_feature, ctx.feature('IONIQ 5', F.BATTERY_LEVEL));
  const empty = await widget.get({ settings: {} });
  assert.equal(empty.components[0].type, 'text');
  await ctx.runtime.stop();
});

test('widget buttons answer with a bilingual toast, even when the car refuses', async () => {
  const ctx = await created({ client: createFakeClient({ result: ['success', 'failed'] }) });
  const widget = createWidgets(ctx.runtime).vehicle;
  const settings = { device: ctx.device('EV9').external_id };
  assert.deepEqual(await widget.action({ actionKey: 'lock', settings }), {
    en: 'Vehicle locked',
    fr: 'Véhicule verrouillé',
  });
  assert.deepEqual(await widget.action({ actionKey: 'unlock', settings }), STATUS_MESSAGES.failed);
  const noPin = createFakeClient({ fail: { lock: 'pin' } });
  const other = await created({ client: noPin });
  const toast = await createWidgets(other.runtime).vehicle.action({
    actionKey: 'lock',
    settings: { device: other.device('EV9').external_id },
  });
  assert.deepEqual(toast, STATUS_MESSAGES.pin);
  await ctx.runtime.drain();
  await ctx.runtime.stop();
  await other.runtime.stop();
});

test('the connection test lists the cars and asks for the PIN when needed', async () => {
  const ctx = await started();
  const message = await ctx.runtime.testConnection();
  assert.match(message.en, /^Connected: 4 vehicle\(s\)/);
  assert.match(message.fr, /code PIN/);
  const withPin = await started({ config: { pin: '1234' } });
  assert.doesNotMatch((await withPin.runtime.testConnection()).en, /PIN/);
  await ctx.runtime.stop();
  await withPin.runtime.stop();
});
