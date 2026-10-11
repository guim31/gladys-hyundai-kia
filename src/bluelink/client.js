// -----------------------------------------------------------------------------
// Client of the European Bluelink / Kia Connect vehicle API ("CCAPI").
//
// Ported from hyundai_kia_connect_api (MIT): ApiImplType1.py and KiaUvoApiEU.py.
// Two protocols coexist, chosen per car by the `ccuCCS2ProtocolSupport` flag
// of the vehicle list:
//   - the original one (flag 0): state under `vehicleStatus`, commands under
//     /api/v1/spa/vehicles/<id>/control/*, without PIN;
//   - "CCS2" (newer cars): state as a `Vehicle` tree (Green, Cabin, Body...),
//     commands under /api/v2/spa/vehicles/<id>/ccs2/control/*, authorized by a
//     control token obtained with the account PIN.
//
// A command answers at once with a message id: the car carries it out later
// (often 10 to 60 s), and its outcome is read from the notification records.
//
// The token set lives in a `tokenStore` (persisted under /data by the runtime):
// signing in again at every start would register a new "phone" each time.
// -----------------------------------------------------------------------------

import { ACTION_RESULTS, CLIMATE_TEMPERATURES } from './constants.js';
import { BluelinkError, ERROR_KINDS, checkCcapiResponse } from './errors.js';
import { TOKEN_MARGIN_MS, computeStamp, createAuth } from './auth.js';

/** Hexadecimal temperature code of the original protocol ("0EH" = 21 °C). */
export function temperatureCode(celsius) {
  const index = CLIMATE_TEMPERATURES.indexOf(Math.round(celsius * 2) / 2);
  if (index < 0) throw new BluelinkError(ERROR_KINDS.API, `Temperature out of range: ${celsius}`);
  return `${index.toString(16).toUpperCase()}H`.padStart(3, '0');
}

/** °C of a hexadecimal temperature code, or undefined ("LO", "HI"...). */
export function temperatureFromCode(code) {
  if (typeof code !== 'string') return undefined;
  const index = Number.parseInt(code.replace(/H$/i, ''), 16);
  return Number.isInteger(index) ? CLIMATE_TEMPERATURES[index] : undefined;
}

/**
 * @param {object} options
 * @param {object} options.constants brandConstants(...)
 * @param {object} options.http createHttp(...)
 * @param {{ username: string, password: string, pin: string, language: string }} options.credentials
 * @param {{ get: () => object|null, set: (tokens: object|null) => void }} options.tokenStore
 */
export function createBluelinkClient({
  constants,
  http,
  credentials,
  tokenStore,
  now = Date.now,
  auth,
}) {
  auth ??= createAuth({ constants, http, now });
  let control = null; // { token, until }
  let pending = null;

  function sameAccount(tokens) {
    return tokens && tokens.username === credentials.username && tokens.brand === constants.brand;
  }

  async function signIn() {
    const tokens = await auth.login(credentials);
    const stored = { ...tokens, username: credentials.username, brand: constants.brand };
    tokenStore.set(stored);
    control = null;
    return stored;
  }

  async function renew(tokens) {
    try {
      const renewed = await auth.refresh(tokens, { language: credentials.language });
      const stored = { ...renewed, username: credentials.username, brand: constants.brand };
      tokenStore.set(stored);
      control = null;
      return stored;
    } catch (err) {
      if (err.kind === ERROR_KINDS.NETWORK) throw err;
      // Like the library: a refused refresh falls back to a full sign-in.
      return signIn();
    }
  }

  /** A valid token set, signing in or refreshing when needed (one at a time). */
  async function tokens({ forceRenew = false } = {}) {
    if (pending) return pending;
    const current = tokenStore.get();
    if (!forceRenew && sameAccount(current) && current.validUntil - TOKEN_MARGIN_MS > now()) {
      return current;
    }
    pending = (sameAccount(current) ? renew(current) : signIn()).finally(() => {
      pending = null;
    });
    return pending;
  }

  function headers(set, ccs2 = 0, extra = {}) {
    return {
      Authorization: set.accessToken,
      'ccsp-service-id': constants.serviceId,
      'ccsp-application-id': constants.appId,
      Stamp: computeStamp(constants, now()),
      'ccsp-device-id': set.deviceId,
      Ccuccs2protocolsupport: String(ccs2 ? 1 : 0),
      'User-Agent': constants.userAgent,
      ...extra,
    };
  }

  /**
   * One CCAPI call, with one retry after a refreshed token or a new device id.
   * @param {(set: object) => Promise<{ url: string, options: object }>} build
   */
  async function call(build) {
    let retried = false;
    for (;;) {
      const set = await tokens();
      const { url, options } = await build(set);
      const response = await http.request(url, options);
      try {
        return checkCcapiResponse(response.json(), response.status);
      } catch (err) {
        if (retried) throw err;
        if (err.kind === ERROR_KINDS.TOKEN_EXPIRED) {
          retried = true;
          await tokens({ forceRenew: true });
          continue;
        }
        if (err.kind === ERROR_KINDS.DEVICE_ID) {
          // The cloud drops a device id whose push deliveries fail.
          retried = true;
          const deviceId = await auth.registerDevice();
          tokenStore.set({ ...tokenStore.get(), deviceId });
          control = null;
          continue;
        }
        throw err;
      }
    }
  }

  const get = (path, ccs2, base = constants.spaApiUrl) =>
    call(async (set) => ({ url: `${base}${path}`, options: { headers: headers(set, ccs2) } }));

  /** Control token of the CCS2 commands, from the PIN (cached until it expires). */
  async function controlToken(set) {
    if (control && control.until > now() && control.deviceId === set.deviceId) return control.token;
    if (!credentials.pin) {
      throw new BluelinkError(
        ERROR_KINDS.PIN,
        'This car needs the PIN of the account for commands: enter it in the configuration',
      );
    }
    const response = await http.request(`${constants.userApiUrl}pin?token=`, {
      method: 'PUT',
      headers: { Authorization: set.accessToken, 'User-Agent': constants.userAgent },
      json: { deviceId: set.deviceId, pin: credentials.pin },
    });
    let body = null;
    try {
      body = response.json();
    } catch {
      // handled below
    }
    if (!body?.controlToken) {
      throw new BluelinkError(
        ERROR_KINDS.PIN,
        'The PIN was refused: check it in the configuration',
      );
    }
    const seconds = Number(body.expiresTime);
    control = {
      token: `Bearer ${body.controlToken}`,
      until: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 600) * 1000 - 30000,
      deviceId: set.deviceId,
    };
    return control.token;
  }

  /** POST a command; resolves with its message id. */
  async function command(vehicle, { v1, v2, payload, ccs2Payload }) {
    const body = await call(async (set) => {
      if (vehicle.ccs2) {
        const token = await controlToken(set);
        return {
          url: `${constants.spaApiUrlV2}vehicles/${vehicle.id}/${v2}`,
          options: {
            headers: headers(set, 1, { Authorization: token, AuthorizationCCSP: token }),
            json: ccs2Payload,
          },
        };
      }
      return {
        url: `${constants.spaApiUrl}vehicles/${vehicle.id}/${v1}`,
        options: { headers: headers(set, 0), json: { ...payload, deviceId: set.deviceId } },
      };
    });
    return body.msgId;
  }

  return {
    /** Sign in (or reuse the stored tokens): throws when the account refuses. */
    async connect() {
      await tokens();
    },

    /** Vehicles of the account. */
    async vehicles() {
      const body = await get('vehicles', 0);
      return Array.isArray(body?.resMsg?.vehicles) ? body.resMsg.vehicles : [];
    },

    /**
     * Last state the car sent to the cloud. Never wakes the car.
     * @returns {Promise<object>} `vehicleStatusInfo` (original) or `Vehicle` tree (CCS2)
     */
    async cachedStatus(vehicle) {
      if (vehicle.ccs2) {
        const body = await get(`vehicles/${vehicle.id}/ccs2/carstatus/latest`, 1);
        return body?.resMsg?.state?.Vehicle ?? {};
      }
      const body = await get(`vehicles/${vehicle.id}/status/latest`, 0);
      return body?.resMsg?.vehicleStatusInfo ?? {};
    },

    /**
     * Ask the car itself for its state: wakes its modem, costs 12 V battery and
     * daily quota. CCS2 cars answer through the cache, read after a delay.
     * @returns {Promise<object>} same shapes as cachedStatus (no odometer for
     *   the original protocol)
     */
    async forcedStatus(vehicle, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
      if (vehicle.ccs2) {
        await get(`vehicles/${vehicle.id}/ccs2/carstatus`, 1);
        await wait(25000);
        return this.cachedStatus(vehicle);
      }
      const body = await get(`vehicles/${vehicle.id}/status`, 0);
      return { vehicleStatus: body?.resMsg ?? {} };
    },

    startCharge: (vehicle) =>
      command(vehicle, {
        v1: 'control/charge',
        v2: 'ccs2/control/charge',
        payload: { action: 'start' },
        ccs2Payload: { command: 'start' },
      }),

    stopCharge: (vehicle) =>
      command(vehicle, {
        v1: 'control/charge',
        v2: 'ccs2/control/charge',
        payload: { action: 'stop' },
        ccs2Payload: { command: 'stop' },
      }),

    lock: (vehicle) =>
      command(vehicle, {
        v1: 'control/door',
        v2: 'ccs2/control/door',
        payload: { action: 'close' },
        ccs2Payload: { command: 'close' },
      }),

    unlock: (vehicle) =>
      command(vehicle, {
        v1: 'control/door',
        v2: 'ccs2/control/door',
        payload: { action: 'open' },
        ccs2Payload: { command: 'open' },
      }),

    /**
     * Start the climate (defaults of the library: 5 minutes, no defrost).
     * @param {{ temperature: number, duration?: number, defrost?: boolean, leftHandDrive?: boolean }} options
     */
    startClimate(vehicle, { temperature, duration = 5, defrost = false, leftHandDrive = true }) {
      return command(vehicle, {
        v1: 'control/temperature',
        v2: 'ccs2/control/temperature',
        payload: {
          action: 'start',
          hvacType: 0,
          options: { defrost, heating1: 0, igniOnDuration: duration },
          tempCode: temperatureCode(temperature),
          unit: 'C',
        },
        ccs2Payload: {
          command: 'start',
          ignitionDuration: duration,
          strgWhlHeating: null,
          hvacTempType: 1,
          hvacTemp: Math.round(temperature * 2) / 2,
          sideRearMirrorHeating: 0,
          drvSeatLoc: leftHandDrive ? 'L' : 'R',
          seatClimateInfo: {
            drvSeatClimateState: null,
            psgSeatClimateState: null,
            rrSeatClimateState: null,
            rlSeatClimateState: null,
          },
          tempUnit: 'C',
          windshieldFrontDefogState: defrost,
        },
      });
    },

    stopClimate: (vehicle) =>
      command(vehicle, {
        v1: 'control/temperature',
        v2: 'ccs2/control/temperature',
        payload: {
          action: 'stop',
          hvacType: 0,
          options: { defrost: true, heating1: 1 },
          tempCode: '10H',
          unit: 'C',
        },
        ccs2Payload: { command: 'stop' },
      }),

    /** AC and DC charge limits, in percent (50 to 100 by 10). Same call for both protocols. */
    async setChargeLimits(vehicle, { ac, dc }) {
      const body = await call(async (set) => ({
        url: `${constants.spaApiUrl}vehicles/${vehicle.id}/charge/target`,
        options: {
          headers: headers(set, vehicle.ccs2),
          json: {
            targetSOClist: [
              { plugType: 0, targetSOClevel: Math.round(dc) },
              { plugType: 1, targetSOClevel: Math.round(ac) },
            ],
          },
        },
      }));
      return body.msgId;
    },

    /** Outcome of a command, from the notification records. */
    async actionResult(vehicle, msgId) {
      const body = await get(`notifications/${vehicle.id}/records`, vehicle.ccs2);
      const record = (Array.isArray(body?.resMsg) ? body.resMsg : []).find(
        (r) => r.recordId === msgId,
      );
      if (!record) return ACTION_RESULTS.UNKNOWN;
      if (record.result === 'success') return ACTION_RESULTS.SUCCESS;
      if (record.result === 'fail') return ACTION_RESULTS.FAILED;
      if (record.result === 'non-response') return ACTION_RESULTS.TIMEOUT;
      return ACTION_RESULTS.PENDING;
    },
  };
}
