import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brandConstants } from '../src/bluelink/constants.js';
import { createHttp } from '../src/bluelink/http.js';
import {
  createBluelinkClient,
  temperatureCode,
  temperatureFromCode,
} from '../src/bluelink/client.js';
import { ERROR_KINDS } from '../src/bluelink/errors.js';
import { createFakeFetch, fail, ok } from './helpers/fakeFetch.js';

const NOW = Date.UTC(2026, 9, 11, 8, 0, 0);
const kia = brandConstants('kia');
// A canned answer from test/fixtures/bluelink/.
const fixture = (name) => ({
  json: JSON.parse(
    readFileSync(new URL(`./fixtures/bluelink/${name}.json`, import.meta.url), 'utf8'),
  ),
});

const EV6 = { id: 'veh-1', ccs2: false };
const EV9 = { id: 'veh-2', ccs2: true };

function setup(routes, { pin = '1234', tokens } = {}) {
  const fake = createFakeFetch(routes);
  let stored = tokens ?? {
    kind: 'cci',
    deviceId: 'device-1',
    accessToken: 'Bearer ccs-1',
    validUntil: NOW + 3600 * 1000,
    username: 'driver@example.com',
    brand: 'kia',
  };
  const calls = { login: 0, refresh: 0, register: 0 };
  const auth = {
    async login() {
      calls.login += 1;
      return {
        kind: 'cci',
        deviceId: 'device-1',
        accessToken: 'Bearer login',
        validUntil: NOW + 3600e3,
      };
    },
    async refresh() {
      calls.refresh += 1;
      return {
        kind: 'cci',
        deviceId: 'device-1',
        accessToken: 'Bearer refreshed',
        validUntil: NOW + 3600e3,
      };
    },
    async registerDevice() {
      calls.register += 1;
      return 'device-2';
    },
  };
  const client = createBluelinkClient({
    constants: kia,
    http: createHttp({ fetchImpl: fake.fetchImpl }),
    credentials: { username: 'driver@example.com', password: 'secret', pin, language: 'fr' },
    tokenStore: {
      get: () => stored,
      set: (value) => {
        stored = value;
      },
    },
    now: () => NOW,
    auth,
  });
  return { client, requests: fake.requests, calls, tokens: () => stored };
}

test('temperature codes of the original protocol', () => {
  assert.equal(temperatureCode(21), '0EH');
  assert.equal(temperatureCode(14), '00H');
  assert.equal(temperatureCode(22.5), '11H');
  assert.equal(temperatureFromCode('10H'), 22);
  assert.equal(temperatureFromCode('LO'), undefined);
  assert.throws(() => temperatureCode(40));
});

test('stored tokens are reused: no sign-in at each start', async () => {
  const { client, calls, requests } = setup([
    { url: /\/spa\/vehicles$/, reply: () => fixture('vehicles') },
  ]);
  const list = await client.vehicles();
  assert.equal(list.length, 4);
  assert.equal(calls.login, 0);
  assert.equal(requests[0].headers.Authorization, 'Bearer ccs-1');
  assert.equal(requests[0].headers['ccsp-device-id'], 'device-1');
  assert.ok(requests[0].headers.Stamp);
});

test('tokens of another account are not reused', async () => {
  const { client, calls } = setup([{ url: /\/spa\/vehicles$/, reply: () => fixture('vehicles') }], {
    tokens: {
      kind: 'cci',
      deviceId: 'd',
      accessToken: 'Bearer other',
      validUntil: NOW + 3600e3,
      username: 'someone@else.com',
      brand: 'kia',
    },
  });
  await client.vehicles();
  assert.equal(calls.login, 1);
});

test('an expired token is refreshed once and the call replayed', async () => {
  const { client, calls, requests } = setup([
    { url: /\/spa\/vehicles$/, reply: () => [fail(7501), fixture('vehicles')] },
  ]);
  const list = await client.vehicles();
  assert.equal(list.length, 4);
  assert.equal(calls.refresh, 1);
  assert.equal(requests[1].headers.Authorization, 'Bearer refreshed');
});

test('a dropped device id is registered again', async () => {
  const { client, calls, requests, tokens } = setup([
    { url: /\/spa\/vehicles$/, reply: () => [fail(4002), fixture('vehicles')] },
  ]);
  await client.vehicles();
  assert.equal(calls.register, 1);
  assert.equal(requests[1].headers['ccsp-device-id'], 'device-2');
  assert.equal(tokens().deviceId, 'device-2');
});

test('cloud error codes become error kinds', async () => {
  for (const [code, kind] of [
    [5091, ERROR_KINDS.RATE_LIMIT],
    [4081, ERROR_KINDS.CAR_UNAVAILABLE],
    [4004, ERROR_KINDS.DUPLICATE],
    [4005, ERROR_KINDS.UNSUPPORTED],
  ]) {
    const { client } = setup([{ url: /status\/latest$/, reply: () => fail(code) }]);
    await assert.rejects(client.cachedStatus(EV6), { kind });
  }
});

test('the cached state: original protocol and CCS2', async () => {
  const { client, requests } = setup([
    { url: /veh-1\/status\/latest$/, reply: () => fixture('status_latest_ev6') },
    { url: /veh-2\/ccs2\/carstatus\/latest$/, reply: () => fixture('ccs2_latest_ev9') },
  ]);
  const info = await client.cachedStatus(EV6);
  assert.equal(info.vehicleStatus.evStatus.batteryStatus, 76);
  assert.equal(requests[0].headers.Ccuccs2protocolsupport, '0');
  const tree = await client.cachedStatus(EV9);
  assert.equal(tree.Green.BatteryManagement.BatteryRemain.Ratio, 71);
  assert.equal(requests[1].headers.Ccuccs2protocolsupport, '1');
});

test('a forced refresh of a CCS2 car asks the car, waits, then reads the cache', async () => {
  const waits = [];
  const { client, requests } = setup([
    { url: /veh-2\/ccs2\/carstatus$/, reply: () => ok({}) },
    { url: /veh-2\/ccs2\/carstatus\/latest$/, reply: () => fixture('ccs2_latest_ev9') },
  ]);
  const tree = await client.forcedStatus(EV9, { wait: async (ms) => waits.push(ms) });
  assert.equal(tree.DrivingReady, false);
  assert.deepEqual(waits, [25000]);
  assert.deepEqual(
    requests.map((r) => new URL(r.url).pathname.split('/').slice(-2).join('/')),
    ['ccs2/carstatus', 'carstatus/latest'],
  );
});

test('original protocol commands carry the device id, no PIN', async () => {
  const { client, requests } = setup([
    {
      method: 'POST',
      url: /veh-1\/control\/temperature$/,
      reply: () => ok({}, { msgId: 'msg-1' }),
    },
  ]);
  const msgId = await client.startClimate(EV6, { temperature: 21, duration: 10 });
  assert.equal(msgId, 'msg-1');
  const body = JSON.parse(requests[0].body);
  assert.equal(body.deviceId, 'device-1');
  assert.equal(body.tempCode, '0EH');
  assert.equal(body.options.igniOnDuration, 10);
  assert.ok(!requests.some((r) => r.url.includes('/user/pin')));
});

test('CCS2 commands are authorized by a control token from the PIN, cached', async () => {
  const { client, requests } = setup([
    {
      method: 'PUT',
      url: /\/api\/v1\/user\/pin\?token=$/,
      reply: () => ({ json: { controlToken: 'ctl', expiresTime: 600 } }),
    },
    {
      method: 'POST',
      url: /\/api\/v2\/spa\/vehicles\/veh-2\/ccs2\/control\/door$/,
      reply: () => ok({}, { msgId: 'm' }),
    },
  ]);
  await client.lock(EV9);
  await client.unlock(EV9);
  const pins = requests.filter((r) => r.url.includes('/user/pin'));
  assert.equal(pins.length, 1);
  assert.deepEqual(JSON.parse(pins[0].body), { deviceId: 'device-1', pin: '1234' });
  const doors = requests.filter((r) => r.url.endsWith('/control/door'));
  assert.equal(doors[0].headers.Authorization, 'Bearer ctl');
  assert.deepEqual(JSON.parse(doors[0].body), { command: 'close' });
  assert.deepEqual(JSON.parse(doors[1].body), { command: 'open' });
});

test('a CCS2 command without PIN, or with a refused one, is a PIN error', async () => {
  const none = setup([], { pin: '' });
  await assert.rejects(none.client.lock(EV9), { kind: ERROR_KINDS.PIN });
  const refused = setup([
    {
      method: 'PUT',
      url: /\/user\/pin/,
      reply: () => ({ status: 400, json: { errCode: '4000' } }),
    },
  ]);
  await assert.rejects(refused.client.lock(EV9), { kind: ERROR_KINDS.PIN });
});

test('charge limits: one call, DC as plug type 0 and AC as 1', async () => {
  const { client, requests } = setup([
    { method: 'POST', url: /veh-2\/charge\/target$/, reply: () => ok({}, { msgId: 'm' }) },
  ]);
  await client.setChargeLimits(EV9, { ac: 90, dc: 80 });
  assert.deepEqual(JSON.parse(requests[0].body).targetSOClist, [
    { plugType: 0, targetSOClevel: 80 },
    { plugType: 1, targetSOClevel: 90 },
  ]);
});

test('the outcome of a command is read from the notification records', async () => {
  const records = (result) =>
    ok([
      { recordId: 'other', result: 'fail' },
      { recordId: 'msg-1', result },
    ]);
  for (const [result, expected] of [
    ['success', 'success'],
    ['fail', 'failed'],
    ['non-response', 'timeout'],
    [null, 'pending'],
  ]) {
    const { client } = setup([
      { url: /notifications\/veh-1\/records$/, reply: () => records(result) },
    ]);
    assert.equal(await client.actionResult(EV6, 'msg-1'), expected);
  }
  const { client } = setup([{ url: /records$/, reply: () => ok([]) }]);
  assert.equal(await client.actionResult(EV6, 'msg-1'), 'unknown');
});
