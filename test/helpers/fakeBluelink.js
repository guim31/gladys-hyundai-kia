// -----------------------------------------------------------------------------
// Fake Bluelink client for the runtime tests, answering from
// test/fixtures/bluelink/. Every call is recorded, so the tests can assert what
// was (not) requested — above all that no car is woken unasked.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { BluelinkError } from '../../src/bluelink/errors.js';

export function fixture(name) {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/bluelink/${name}.json`, import.meta.url), 'utf8'),
  ).resMsg;
}

export const VEHICLES = fixture('vehicles').vehicles;
export const IDS = Object.fromEntries(VEHICLES.map((v) => [v.vehicleName, v.vehicleId]));

const STATES = {
  [IDS['IONIQ 5']]: () => fixture('status_latest_ev6').vehicleStatusInfo,
  [IDS.EV9]: () => fixture('ccs2_latest_ev9').state.Vehicle,
  [IDS.Sportage]: () => fixture('ccs2_latest_sportage_phev').state.Vehicle,
  [IDS.i30]: () => fixture('status_latest_ice').vehicleStatusInfo,
};

/**
 * @param {object} [options]
 * @param {Array<object>} [options.vehicles] the vehicle list
 * @param {Record<string, Error|string>} [options.fail] method name → error kind (or error) to throw
 * @param {string|string[]} [options.result] outcome(s) of the commands, in turn
 */
export function createFakeClient({ vehicles = VEHICLES, fail = {}, result = 'success' } = {}) {
  const calls = [];
  const states = new Map(Object.entries(STATES).map(([id, read]) => [id, read()]));
  const results = [].concat(result);
  let msg = 0;
  const maybeFail = (name) => {
    const error = fail[name];
    if (!error) return;
    throw typeof error === 'string' ? new BluelinkError(error, `${name} failed`) : error;
  };
  const record = (name, ...args) => {
    calls.push({ name, args });
    maybeFail(name);
  };
  const command = (name) => async (ref, args) => {
    record(name, ref, args);
    msg += 1;
    return `msg-${msg}`;
  };
  return {
    calls,
    states,
    count: (name) => calls.filter((c) => c.name === name).length,
    async connect() {
      record('connect');
    },
    async vehicles() {
      record('vehicles');
      return structuredClone(vehicles);
    },
    async cachedStatus(ref) {
      record('cachedStatus', ref);
      return structuredClone(states.get(ref.id) ?? {});
    },
    async forcedStatus(ref) {
      record('forcedStatus', ref);
      const state = structuredClone(states.get(ref.id) ?? {});
      // The original protocol answers the bare vehicleStatus.
      return ref.ccs2 ? state : { vehicleStatus: state.vehicleStatus };
    },
    startCharge: command('startCharge'),
    stopCharge: command('stopCharge'),
    lock: command('lock'),
    unlock: command('unlock'),
    startClimate: command('startClimate'),
    stopClimate: command('stopClimate'),
    setChargeLimits: command('setChargeLimits'),
    async actionResult(ref, msgId) {
      record('actionResult', ref, msgId);
      return results.length > 1 ? results.shift() : results[0];
    },
  };
}

/** A store kept in memory, same surface as src/store.js. */
export function createMemoryStore(initial = {}) {
  const data = { version: 1, tokens: null, vehicles: {}, ...initial };
  return {
    data,
    load: async () => data,
    flush: async () => {},
    touch() {},
    tokenStore: {
      get: () => data.tokens,
      set: (tokens) => {
        data.tokens = tokens;
      },
    },
  };
}
