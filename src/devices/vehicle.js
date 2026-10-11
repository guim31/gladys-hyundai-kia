// -----------------------------------------------------------------------------
// Device type: HYUNDAI / KIA VEHICLE.
//
// One Gladys device per car, keyed on the VIN (it never changes, unlike the
// car's nickname or its cloud vehicle id, which a re-registration renews).
//
// The state comes from the Bluelink / Kia Connect cloud in one of two shapes
// (see src/bluelink/client.js): the original `vehicleStatus` object or the
// newer "CCS2" `Vehicle` tree. Both are folded into one canonical snapshot
// (km, °C, minutes), the field mapping being that of hyundai_kia_connect_api
// (ApiImplType1._update_vehicle_properties / _ccs2). The published states are
// derived from the snapshot, in the unit of the feature.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { t } from '../i18n.js';
import { distanceIn, round } from '../units.js';

export const VEHICLE_DEVICE_TYPE = 'vehicle';

// Feature keys: part of the external_id, frozen once published.
export const VEHICLE_FEATURES = {
  BATTERY_LEVEL: 'battery-level',
  RANGE: 'range',
  TOTAL_RANGE: 'total-range',
  CHARGING_STATE: 'charging-state',
  CHARGING: 'charging',
  PLUGGED: 'plugged',
  CHARGE_LIMIT_AC: 'charge-limit-ac',
  CHARGE_LIMIT_DC: 'charge-limit-dc',
  CHARGE_TIME_REMAINING: 'charge-time-remaining',
  CLIMATE: 'climate',
  TARGET_TEMPERATURE: 'target-temperature',
  OUTSIDE_TEMPERATURE: 'outside-temperature',
  LOCKED: 'locked',
  DOOR_OPEN: 'door-open',
  WINDOW_OPEN: 'window-open',
  ODOMETER: 'odometer',
  BATTERY_12V: 'battery-12v',
  IGNITION: 'ignition',
};

// Charge session states, the Gladys `charging-station/charging-state` enum
// (OCPP values, translated by the Gladys front). The cloud only says whether
// the car charges and whether a cable is fastened.
export const CHARGING_STATION_STATE = { CHARGING: 0, EV_CONNECTED: 1, IDLE: 4 };

// Bounds the cars accept for the commands.
export const CHARGE_LIMIT_MIN = 50;
export const CHARGE_LIMIT_MAX = 100;
export const CHARGE_LIMIT_STEP = 10;
export const CLIMATE_TEMP_MIN_C = 16;
export const CLIMATE_TEMP_MAX_C = 30;
export const DEFAULT_CLIMATE_TEMP_C = 21;

// Vehicle `type` of the vehicle list: EV, PHEV ("PE" on some accounts), HEV
// ("HV"), combustion ("GN"); fuel cell cars ("FCEV") have no plug.
const ELECTRIC_TYPES = new Set(['EV', 'PHEV', 'PE']);
const PLUG_IN_HYBRID_TYPES = new Set(['PHEV', 'PE']);

export const isElectric = (vehicle) =>
  ELECTRIC_TYPES.has(String(vehicle?.type ?? '').toUpperCase());
export const isPlugInHybrid = (vehicle) =>
  PLUG_IN_HYBRID_TYPES.has(String(vehicle?.type ?? '').toUpperCase());
// Any non-zero flag, as hyundai_kia_connect_api reads it.
export const isCcs2 = (vehicle) => {
  const flag = Number(vehicle?.ccuCCS2ProtocolSupport);
  return Number.isFinite(flag) && flag !== 0;
};

export function vehicleIds(gladys, vin) {
  return gladys.externalIds(VEHICLE_DEVICE_TYPE, vin);
}

/** "IONIQ 5", "EV6"… the model the cloud gives, else the brand alone. */
export function vehicleModel(vehicle, brand) {
  const model = String(vehicle?.vehicleName ?? '').trim();
  return model || (brand === 'kia' ? 'Kia' : 'Hyundai');
}

// --- Reading -----------------------------------------------------------------

const num = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return undefined;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};
const at = (object, path) =>
  path
    .split('.')
    .reduce((node, key) => (node === null || node === undefined ? node : node[key]), object);

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
}

/** Any of the values true, false if all known and false, else undefined. */
function anyTrue(values) {
  const known = values.filter((v) => v !== undefined);
  if (known.length === 0) return undefined;
  return known.some(Boolean);
}

// Distance unit codes of the cloud: 1 km, 2 and 3 miles (0 or none: unknown).
const MILES_PER_KM = 1 / 1.609344;
function toKm(value, unit) {
  const n = num(value);
  if (n === undefined) return undefined;
  const code = Number(unit);
  return code === 2 || code === 3 ? n / MILES_PER_KM : n;
}
const unitOfCode = (unit) => {
  const code = Number(unit);
  if (code === 1) return 'km';
  if (code === 2 || code === 3) return 'mi';
  return undefined;
};

/** 12 V battery: unknown when the car flags its sensor as unreliable or sends a sentinel. */
function battery12v(value, reliability) {
  if (Number(reliability) === 1) return undefined;
  const n = num(value);
  return n !== undefined && n >= 0 && n <= 100 ? Math.round(n) : undefined;
}

/**
 * Epoch milliseconds of a "YYYYMMDDHHmmss" timestamp in a time zone (the
 * original protocol stamps the state in Berlin time, CCS2 in UTC).
 */
export function parseCompactTime(value, timeZone = 'UTC') {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/.exec(String(value ?? ''));
  if (!match) return undefined;
  const [y, mo, d, h, mi, s] = match.slice(1).map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  if (timeZone === 'UTC') return asUtc;
  // The zone's offset at that moment (corrected once around a DST change).
  const offset = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return (
      Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour'),
        get('minute'),
        get('second'),
      ) - ms
    );
  };
  const first = asUtc - offset(asUtc);
  return asUtc - offset(first);
}

/**
 * Snapshot of the original protocol: a `vehicleStatusInfo` ({ vehicleStatus,
 * odometer }) from the cached read, or { vehicleStatus } from a forced read.
 */
export function snapshotFromStatus(info = {}) {
  const status = info.vehicleStatus ?? {};
  const ev = status.evStatus ?? {};
  const range = at(ev, 'drvDistance.0.rangeByFuel') ?? {};
  const evRange = range.evModeRange ?? range.totalAvailableRange;
  const totalRange = range.totalAvailableRange ?? status.dte;
  const limits = Array.isArray(at(ev, 'reservChargeInfos.targetSOClist'))
    ? ev.reservChargeInfos.targetSOClist
    : [];
  const limit = (plugType) =>
    num(limits.find((l) => Number(l.plugType) === plugType)?.targetSOClevel);
  const doors = status.doorOpen ?? {};
  const windows = status.windowOpen ?? {};
  const plugin = num(ev.batteryPlugin);
  return compact({
    updatedAt: parseCompactTime(status.time, 'Europe/Berlin'),
    evBattery: num(ev.batteryStatus),
    evRangeKm: toKm(evRange?.value, evRange?.unit),
    totalRangeKm: toKm(totalRange?.value, totalRange?.unit),
    distanceUnit: unitOfCode(info.odometer?.unit ?? totalRange?.unit),
    charging: bool(ev.batteryCharge),
    plugged: plugin === undefined ? undefined : plugin > 0,
    chargeLimitAc: limit(1),
    chargeLimitDc: limit(0),
    chargeRemainingMin: num(at(ev, 'remainTime2.atc.value')),
    climateOn: bool(status.airCtrlOn),
    locked: bool(status.doorLock),
    doorOpen: anyTrue([
      ...Object.values(doors).map(bool),
      bool(status.trunkOpen),
      bool(status.hoodOpen),
    ]),
    windowOpen: anyTrue(Object.values(windows).map(bool)),
    odometerKm: toKm(info.odometer?.value, info.odometer?.unit),
    battery12v: battery12v(at(status, 'battery.batSoc')),
    ignition: bool(status.engine),
  });
}

const ROWS = ['Row1.Driver', 'Row1.Passenger', 'Row2.Left', 'Row2.Right'];

/** Snapshot of the CCS2 protocol, from the `Vehicle` tree. */
export function snapshotFromCcs2(state = {}) {
  const dte = at(state, 'Drivetrain.FuelSystem.DTE') ?? {};
  const remain = num(at(state, 'Green.ChargingInformation.Charging.RemainTime'));
  const locks = ROWS.map((row) => at(state, `Cabin.Door.${row}.Lock`));
  // `Lock: false` means locked (as hyundai_kia_connect_api reads it).
  const locked = locks.every((v) => v !== undefined && v !== null)
    ? locks.every((v) => !v)
    : undefined;
  const outside = num(at(state, 'Cabin.HVAC.OutsideTemperature.Value'));
  const outsideUnit = num(at(state, 'Cabin.HVAC.OutsideTemperature.Unit'));
  return compact({
    updatedAt: parseCompactTime(state.Date, 'UTC'),
    evBattery: num(at(state, 'Green.BatteryManagement.BatteryRemain.Ratio')),
    evRangeKm: toKm(dte.EV ?? dte.Total, dte.Unit),
    totalRangeKm: toKm(dte.Total, dte.Unit),
    distanceUnit: unitOfCode(dte.Unit),
    charging: remain === undefined ? undefined : remain > 0,
    plugged: bool(at(state, 'Green.ChargingInformation.ConnectorFastening.State')),
    chargeLimitAc: num(at(state, 'Green.ChargingInformation.TargetSoC.Standard')),
    chargeLimitDc: num(at(state, 'Green.ChargingInformation.TargetSoC.Quick')),
    chargeRemainingMin: remain,
    climateOn: (() => {
      const speed = num(at(state, 'Cabin.HVAC.Row1.Driver.Blower.SpeedLevel'));
      return speed === undefined ? undefined : speed > 0;
    })(),
    // Only °C readings are kept (a °F reading would need its own unit).
    outsideTempC: outsideUnit === 1 ? undefined : outside,
    locked,
    doorOpen: anyTrue([
      ...ROWS.map((row) => bool(at(state, `Cabin.Door.${row}.Open`))),
      bool(at(state, 'Body.Trunk.Open')),
      bool(at(state, 'Body.Hood.Open')),
    ]),
    windowOpen: anyTrue(ROWS.map((row) => bool(at(state, `Cabin.Window.${row}.Open`)))),
    odometerKm: num(at(state, 'Drivetrain.Odometer')),
    battery12v: battery12v(
      at(state, 'Electronics.Battery.Level'),
      at(state, 'Electronics.Battery.SensorReliability'),
    ),
    ignition: bool(state.DrivingReady),
  });
}

/** Snapshot of either shape. */
export function snapshotFrom(raw, ccs2) {
  return ccs2 ? snapshotFromCcs2(raw) : snapshotFromStatus(raw);
}

// --- Publishing ----------------------------------------------------------------

/**
 * The discovery payload of one car.
 * @param {object} gladys SDK instance
 * @param {object} vehicle entry of the vehicle list (vin, nickname, vehicleName, type, ccuCCS2ProtocolSupport)
 * @param {{ language: string, brand: string, distanceUnit: string }} options
 */
export function buildVehicleDevice(gladys, vehicle, { language, brand, distanceUnit }) {
  const ids = vehicleIds(gladys, vehicle.vin);
  const model = vehicleModel(vehicle, brand);
  const distance = distanceUnit === 'mi' ? UNITS.MILE : UNITS.KM;
  const feature = (key, name, category, type, extra) => ({
    name: t(language, name),
    external_id: ids.feature(key),
    category,
    type,
    read_only: true,
    has_feedback: false,
    keep_history: true,
    min: 0,
    max: 1,
    ...extra,
  });
  const command = { read_only: false, has_feedback: true };
  const features = [];
  if (isElectric(vehicle)) {
    features.push(
      feature(
        VEHICLE_FEATURES.BATTERY_LEVEL,
        'batteryLevel',
        CATEGORIES.ELECTRICAL_VEHICLE_BATTERY,
        TYPES.ELECTRICAL_VEHICLE_BATTERY.BATTERY_LEVEL,
        { unit: UNITS.PERCENT, max: 100 },
      ),
      feature(
        VEHICLE_FEATURES.RANGE,
        isPlugInHybrid(vehicle) ? 'evRange' : 'range',
        CATEGORIES.ELECTRICAL_VEHICLE_BATTERY,
        TYPES.ELECTRICAL_VEHICLE_BATTERY.BATTERY_RANGE_ESTIMATE,
        { unit: distance, max: 1000 },
      ),
      feature(
        VEHICLE_FEATURES.CHARGING_STATE,
        'chargingState',
        CATEGORIES.CHARGING_STATION,
        TYPES.CHARGING_STATION.CHARGING_STATE,
        { max: 5 },
      ),
      feature(
        VEHICLE_FEATURES.CHARGING,
        'charging',
        CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ON,
        command,
      ),
      feature(
        VEHICLE_FEATURES.PLUGGED,
        'plugged',
        CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        TYPES.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
      ),
      feature(
        VEHICLE_FEATURES.CHARGE_LIMIT_AC,
        'chargeLimitAc',
        CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        TYPES.ELECTRICAL_VEHICLE_CHARGE.TARGET_CHARGE_LIMIT,
        { ...command, unit: UNITS.PERCENT, min: CHARGE_LIMIT_MIN, max: CHARGE_LIMIT_MAX },
      ),
      feature(
        VEHICLE_FEATURES.CHARGE_LIMIT_DC,
        'chargeLimitDc',
        CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        TYPES.ELECTRICAL_VEHICLE_CHARGE.TARGET_CHARGE_LIMIT,
        { ...command, unit: UNITS.PERCENT, min: CHARGE_LIMIT_MIN, max: CHARGE_LIMIT_MAX },
      ),
      feature(
        VEHICLE_FEATURES.CHARGE_TIME_REMAINING,
        'chargeTimeRemaining',
        CATEGORIES.DURATION,
        TYPES.DURATION.INTEGER,
        { unit: UNITS.MINUTES, max: 3000 },
      ),
    );
  }
  if (!isElectric(vehicle) || isPlugInHybrid(vehicle)) {
    // Fuel (or fuel + battery) range: no EV type fits, a plain distance does.
    features.push(
      feature(
        isElectric(vehicle) ? VEHICLE_FEATURES.TOTAL_RANGE : VEHICLE_FEATURES.RANGE,
        isElectric(vehicle) ? 'totalRange' : 'range',
        CATEGORIES.DISTANCE_SENSOR,
        TYPES.SENSOR.DECIMAL,
        { unit: distance, max: 2000 },
      ),
    );
  }
  features.push(
    feature(
      VEHICLE_FEATURES.CLIMATE,
      'climate',
      CATEGORIES.ELECTRICAL_VEHICLE_CLIMATE,
      TYPES.ELECTRICAL_VEHICLE_CLIMATE.CLIMATE_ON,
      command,
    ),
    feature(
      VEHICLE_FEATURES.TARGET_TEMPERATURE,
      'targetTemp',
      CATEGORIES.ELECTRICAL_VEHICLE_CLIMATE,
      TYPES.ELECTRICAL_VEHICLE_CLIMATE.TARGET_TEMPERATURE,
      {
        ...command,
        // A setpoint kept by the integration, not history worth keeping.
        keep_history: false,
        unit: UNITS.CELSIUS,
        min: CLIMATE_TEMP_MIN_C,
        max: CLIMATE_TEMP_MAX_C,
      },
    ),
  );
  if (isCcs2(vehicle)) {
    // Only the CCS2 protocol reports it.
    features.push(
      feature(
        VEHICLE_FEATURES.OUTSIDE_TEMPERATURE,
        'outsideTemp',
        CATEGORIES.TEMPERATURE_SENSOR,
        TYPES.SENSOR.DECIMAL,
        { unit: UNITS.CELSIUS, min: -40, max: 60 },
      ),
    );
  }
  features.push(
    feature(
      VEHICLE_FEATURES.LOCKED,
      'locked',
      CATEGORIES.ELECTRICAL_VEHICLE_COMMAND,
      TYPES.ELECTRICAL_VEHICLE_COMMAND.LOCK,
      command,
    ),
    feature(
      VEHICLE_FEATURES.DOOR_OPEN,
      'doorOpen',
      CATEGORIES.ELECTRICAL_VEHICLE_STATE,
      TYPES.ELECTRICAL_VEHICLE_STATE.DOOR_OPENED,
    ),
    feature(
      VEHICLE_FEATURES.WINDOW_OPEN,
      'windowOpen',
      CATEGORIES.ELECTRICAL_VEHICLE_STATE,
      TYPES.ELECTRICAL_VEHICLE_STATE.WINDOW_OPENED,
    ),
    feature(
      VEHICLE_FEATURES.ODOMETER,
      'odometer',
      CATEGORIES.ELECTRICAL_VEHICLE_STATE,
      TYPES.ELECTRICAL_VEHICLE_STATE.ODOMETER,
      { unit: distance, max: 2000000 },
    ),
    feature(VEHICLE_FEATURES.BATTERY_12V, 'battery12v', CATEGORIES.BATTERY, TYPES.BATTERY.INTEGER, {
      unit: UNITS.PERCENT,
      max: 100,
    }),
    feature(VEHICLE_FEATURES.IGNITION, 'ignition', CATEGORIES.INPUT, TYPES.INPUT.BINARY),
  );
  return {
    name:
      String(vehicle.nickname ?? '').trim() || `${brand === 'kia' ? 'Kia' : 'Hyundai'} ${model}`,
    external_id: ids.device,
    // The runtime keeps its own pace (cached reads, see src/hyundaiKia.js).
    should_poll: false,
    model,
    features,
  };
}

const binary = (value) => (value === null || value === undefined ? null : value ? 1 : 0);

/** Charge session state of the snapshot (null when unknown). */
export function chargingStationState(snapshot) {
  if (snapshot.charging === true) return CHARGING_STATION_STATE.CHARGING;
  if (snapshot.plugged === true) return CHARGING_STATION_STATE.EV_CONNECTED;
  if (snapshot.plugged === false) return CHARGING_STATION_STATE.IDLE;
  return null;
}

/**
 * States of one car, from its snapshot.
 * @param {object} snapshot canonical snapshot (+ `targetTempC`, the setpoint kept by the runtime)
 * @param {(key: string) => string} unitOf unit of a feature key (the created
 *   device's when it exists, so the values match the stored unit)
 * @param {Set<string>} present feature keys of the device
 * @returns {Array<{ key: string, value: number }>} only the known values
 */
export function vehicleStates(snapshot, unitOf, present) {
  const range = (key, km) => round(distanceIn(unitOf(key), km));
  const rangeKey = present.has(VEHICLE_FEATURES.BATTERY_LEVEL) ? 'evRangeKm' : 'totalRangeKm';
  const states = [
    [VEHICLE_FEATURES.BATTERY_LEVEL, round(snapshot.evBattery)],
    [VEHICLE_FEATURES.RANGE, range(VEHICLE_FEATURES.RANGE, snapshot[rangeKey])],
    [VEHICLE_FEATURES.TOTAL_RANGE, range(VEHICLE_FEATURES.TOTAL_RANGE, snapshot.totalRangeKm)],
    [VEHICLE_FEATURES.CHARGING_STATE, chargingStationState(snapshot)],
    [VEHICLE_FEATURES.CHARGING, binary(snapshot.charging)],
    [VEHICLE_FEATURES.PLUGGED, binary(snapshot.plugged)],
    [VEHICLE_FEATURES.CHARGE_LIMIT_AC, round(snapshot.chargeLimitAc)],
    [VEHICLE_FEATURES.CHARGE_LIMIT_DC, round(snapshot.chargeLimitDc)],
    [
      VEHICLE_FEATURES.CHARGE_TIME_REMAINING,
      // A stale estimate once the session is over means nothing.
      snapshot.charging === false ? 0 : round(snapshot.chargeRemainingMin),
    ],
    [VEHICLE_FEATURES.CLIMATE, binary(snapshot.climateOn)],
    [VEHICLE_FEATURES.TARGET_TEMPERATURE, round(snapshot.targetTempC, 1)],
    [VEHICLE_FEATURES.OUTSIDE_TEMPERATURE, round(snapshot.outsideTempC, 1)],
    [VEHICLE_FEATURES.LOCKED, binary(snapshot.locked)],
    [VEHICLE_FEATURES.DOOR_OPEN, binary(snapshot.doorOpen)],
    [VEHICLE_FEATURES.WINDOW_OPEN, binary(snapshot.windowOpen)],
    [VEHICLE_FEATURES.ODOMETER, range(VEHICLE_FEATURES.ODOMETER, snapshot.odometerKm)],
    [VEHICLE_FEATURES.BATTERY_12V, round(snapshot.battery12v)],
    [VEHICLE_FEATURES.IGNITION, binary(snapshot.ignition)],
  ];
  return states
    .filter(([key, value]) => value !== null && present.has(key))
    .map(([key, value]) => ({ key, value }));
}

// --- Commands ------------------------------------------------------------------

/**
 * Translate a Gladys command into a client order, plus the snapshot change it
 * implies (applied once the car confirmed).
 * @param {string} featureKey
 * @param {number} value
 * @param {object} snapshot current snapshot (for the charge limit not changed)
 * @param {{ climateDuration: number }} options
 * @returns {{ order: string, args?: object, optimistic: object, local?: boolean } | null}
 */
export function vehicleCommand(featureKey, value, snapshot = {}, { climateDuration = 10 } = {}) {
  const on = Number(value) === 1;
  switch (featureKey) {
    case VEHICLE_FEATURES.CHARGING:
      return on
        ? { order: 'startCharge', optimistic: { charging: true } }
        : { order: 'stopCharge', optimistic: { charging: false } };
    case VEHICLE_FEATURES.CHARGE_LIMIT_AC:
    case VEHICLE_FEATURES.CHARGE_LIMIT_DC: {
      const percent = chargeLimit(value);
      const ac = featureKey === VEHICLE_FEATURES.CHARGE_LIMIT_AC;
      // One call sets both limits: the other keeps its known value.
      const other = chargeLimitOrDefault(ac ? snapshot.chargeLimitDc : snapshot.chargeLimitAc);
      const limits = ac ? { ac: percent, dc: other } : { ac: other, dc: percent };
      return {
        order: 'setChargeLimits',
        args: limits,
        optimistic: { chargeLimitAc: limits.ac, chargeLimitDc: limits.dc },
      };
    }
    case VEHICLE_FEATURES.CLIMATE:
      return on
        ? {
            order: 'startClimate',
            args: {
              temperature: climateTemperature(snapshot.targetTempC ?? DEFAULT_CLIMATE_TEMP_C),
              duration: climateDuration,
            },
            optimistic: { climateOn: true },
          }
        : { order: 'stopClimate', optimistic: { climateOn: false } };
    case VEHICLE_FEATURES.TARGET_TEMPERATURE:
      // Kept for the next climate start: the cloud has no "set temperature" alone.
      return { local: true, optimistic: { targetTempC: climateTemperature(value) } };
    case VEHICLE_FEATURES.LOCKED:
      return on
        ? { order: 'lock', optimistic: { locked: true } }
        : { order: 'unlock', optimistic: { locked: false } };
    default:
      return null;
  }
}

function finite(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('Not a number');
  return n;
}

/** A charge limit the cars accept: 50 to 100, by steps of 10. */
export function chargeLimit(value) {
  const n = Math.round(finite(value) / CHARGE_LIMIT_STEP) * CHARGE_LIMIT_STEP;
  return Math.min(CHARGE_LIMIT_MAX, Math.max(CHARGE_LIMIT_MIN, n));
}

const chargeLimitOrDefault = (value) =>
  Number.isFinite(value) ? chargeLimit(value) : CHARGE_LIMIT_MAX;

/** A climate temperature the cars accept: 16 to 30 °C, by half degrees. */
export function climateTemperature(value) {
  const n = Math.round(finite(value) * 2) / 2;
  return Math.min(CLIMATE_TEMP_MAX_C, Math.max(CLIMATE_TEMP_MIN_C, n));
}
