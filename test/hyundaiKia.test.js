import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, validateWidgetContent } from '@gladysassistant/integration-sdk';
import { ActionFailure, createHyundaiKia, STATUS_MESSAGES } from '../src/hyundaiKia.js';
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

test('widget buttons: a multi-language toast on success, a thrown error when the car refuses', async () => {
  const ctx = await created({ client: createFakeClient({ result: ['success', 'failed'] }) });
  const widget = createWidgets(ctx.runtime).vehicle;
  const settings = { device: ctx.device('EV9').external_id };
  assert.deepEqual(await widget.action({ actionKey: 'lock', settings }), {
    en: 'Vehicle locked',
    fr: 'Véhicule verrouillé',
    de: 'Fahrzeug verriegelt',
    es: 'Vehículo bloqueado',
  });
  // The core shows a thrown error in red, a resolved one as a success.
  await assert.rejects(widget.action({ actionKey: 'unlock', settings }), {
    message: STATUS_MESSAGES.failed.en,
  });
  await ctx.runtime.drain();
  await ctx.runtime.stop();
});

test('a command refused for want of the PIN: red toast, widget row, state put back', async () => {
  const ctx = await created({ client: createFakeClient({ fail: { unlock: 'pin' } }) });
  const widget = createWidgets(ctx.runtime).vehicle;
  const device = ctx.device('EV9');
  const settings = { device: device.external_id };
  // The toast follows the language of the last widget read.
  await widget.get({ settings, language: 'fr' });
  await assert.rejects(widget.action({ actionKey: 'unlock', settings }), {
    message: STATUS_MESSAGES.pinMissing.fr,
  });
  let content = await widget.get({ settings, language: 'fr' });
  assert.deepEqual(validateWidgetContent(content), []);
  const rows = content.components.find((c) => c.type === 'status').items;
  const row = rows.find((r) => r.label.en === 'Commands');
  assert.equal(row.color, 'danger');
  assert.match(row.value.fr, /PIN/);

  // From the dashboard: Gladys only logs the error, the known value goes back.
  const lockedId = ctx.feature('EV9', F.LOCKED);
  const before = ctx.gladys.published.filter((st) => st.featureExternalId === lockedId);
  await assert.rejects(
    ctx.runtime.setValue(device, { external_id: lockedId }, 0),
    (err) => err.message === STATUS_MESSAGES.pinMissing.en,
  );
  const after = ctx.gladys.published.filter((st) => st.featureExternalId === lockedId);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.at(-1).state, before.at(-1).state);

  // The same refusal with a PIN saved: the PIN is wrong, not missing.
  const withPin = await created({
    config: { pin: '1234' },
    client: createFakeClient({ fail: { startClimate: 'pin' } }),
  });
  await assert.rejects(
    createSceneActions(withPin.runtime).start_climate({
      fields: { device: withPin.device('EV9').external_id },
    }),
    { message: STATUS_MESSAGES.pin.en },
  );
  assert.equal(withPin.runtime.vehicleView(withPin.device('EV9').external_id).commandIssue, 'pin');
  await ctx.runtime.stop();
  await withPin.runtime.stop();
});

test('an accepted command clears the PIN row of the widget', async () => {
  const fail = { lock: 'pin' };
  const ctx = await created({ client: createFakeClient({ fail }) });
  const id = ctx.device('EV9').external_id;
  await assert.rejects(ctx.runtime.order(id, F.LOCKED, 1));
  assert.equal(ctx.runtime.vehicleView(id).commandIssue, 'pinMissing');
  delete fail.lock;
  await ctx.runtime.order(id, F.LOCKED, 1);
  assert.equal(ctx.runtime.vehicleView(id).commandIssue, null);
  await ctx.runtime.drain();
  await ctx.runtime.stop();
});

test('the connection test lists the cars and asks for the PIN, whatever the protocol', async () => {
  const ctx = await started();
  const message = await ctx.runtime.testConnection();
  assert.match(message.en, /^Connected: 4 vehicle\(s\)/);
  assert.match(message.fr, /code PIN/);
  // Only cars of the original protocol: the PIN is still asked for.
  const original = await started({
    client: createFakeClient({ vehicles: VEHICLES.filter((v) => !v.ccuCCS2ProtocolSupport) }),
  });
  assert.match((await original.runtime.testConnection()).en, /PIN of your account/);
  const withPin = await started({ config: { pin: '1234' } });
  assert.doesNotMatch((await withPin.runtime.testConnection()).en, /PIN/);
  await ctx.runtime.stop();
  await original.runtime.stop();
  await withPin.runtime.stop();
});

test('the connection test throws its failures, so Gladys shows them in red', async () => {
  // Before the configuration is saved: the test reads the saved one only.
  const empty = setup({ config: { username: '', password: '' } });
  await empty.runtime.start(empty.config);
  const notSaved = await empty.runtime.testConnection().catch((err) => err);
  assert.ok(notSaved instanceof ActionFailure);
  // The core relays the thrown message as is: the browser picks the language.
  assert.deepEqual(notSaved.message, STATUS_MESSAGES.notSaved);

  // Not started yet (the action can arrive while the integration starts).
  const early = setup();
  await assert.rejects(early.runtime.testConnection(), (err) => {
    assert.deepEqual(err.message, STATUS_MESSAGES.starting);
    return true;
  });

  // The account refuses the sign-in.
  const refused = await started({ client: createFakeClient({ fail: { connect: 'auth' } }) });
  await assert.rejects(refused.runtime.testConnection(), (err) => {
    assert.deepEqual(err.message, STATUS_MESSAGES.auth);
    return true;
  });

  // An unknown answer of the cloud is said as such, not as "unreachable".
  const odd = await started({ client: createFakeClient({ fail: { vehicles: 'api' } }) });
  await assert.rejects(odd.runtime.testConnection(), (err) => {
    assert.match(err.message.en, /^The cloud refused the request: vehicles failed/);
    assert.match(err.message.fr, /^Le cloud a refusé la requête/);
    return true;
  });
  for (const ctx of [empty, early, refused, odd]) await ctx.runtime.stop();
});

test('the real case: saved account, PIN added later with the password field left empty', async () => {
  // The core keeps an untouched secret (sent as null) and pushes the full
  // configuration to the integration: the password is still there.
  const ctx = await started();
  assert.match((await ctx.runtime.testConnection()).en, /^Connected/);
  await ctx.runtime.reconfigure(
    normalizeConfig({ username: 'driver@example.com', password: 'secret', pin: '1234' }),
  );
  const message = await ctx.runtime.testConnection();
  assert.match(message.en, /^Connected: 4 vehicle\(s\)/);
  assert.doesNotMatch(message.en, /PIN/);
  // A result shown before the configuration was saved stays on screen in
  // Gladys 5.1.4 (the page keeps it): only "Save" then a new test updates it.
  await ctx.runtime.stop();
});
