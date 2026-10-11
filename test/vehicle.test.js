import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  VEHICLE_FEATURES as F,
  buildVehicleDevice,
  chargeLimit,
  climateTemperature,
  isCcs2,
  parseCompactTime,
  snapshotFromCcs2,
  snapshotFromStatus,
  vehicleCommand,
  vehicleStates,
} from '../src/devices/vehicle.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const resMsg = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/bluelink/${name}.json`, import.meta.url), 'utf8'))
    .resMsg;
const VEHICLES = resMsg('vehicles').vehicles;
const [IONIQ5, EV9, SPORTAGE, I30] = VEHICLES;

test('timestamps: Berlin time for the original protocol, UTC for CCS2', () => {
  // 20 July: Berlin is UTC+2.
  assert.equal(parseCompactTime('20240720120000', 'Europe/Berlin'), Date.UTC(2024, 6, 20, 10));
  // 15 January: UTC+1.
  assert.equal(parseCompactTime('20240115120000', 'Europe/Berlin'), Date.UTC(2024, 0, 15, 11));
  assert.equal(parseCompactTime('20260720171532.000', 'UTC'), Date.UTC(2026, 6, 20, 17, 15, 32));
  assert.equal(parseCompactTime('garbage'), undefined);
});

test('original protocol (Kia EV6 2023): the values hyundai_kia_connect_api reads', () => {
  const s = snapshotFromStatus(resMsg('status_latest_ev6').vehicleStatusInfo);
  assert.equal(s.evBattery, 76);
  assert.equal(s.chargeLimitDc, 80);
  assert.equal(s.chargeLimitAc, 100);
  assert.equal(s.battery12v, 85);
  assert.equal(s.ignition, false);
  assert.equal(s.locked, true);
  assert.equal(s.charging, false);
  assert.equal(s.plugged, false);
  assert.equal(s.evRangeKm, 310);
  assert.equal(s.odometerKm, 15234);
  assert.equal(s.distanceUnit, 'km');
  assert.equal(s.climateOn, false);
  assert.equal(s.doorOpen, false);
  assert.equal(s.windowOpen, false);
  assert.equal(s.updatedAt, Date.UTC(2024, 6, 20, 10));
  // Not reported by this protocol.
  assert.equal(s.outsideTempC, undefined);
});

test('a forced read of the original protocol has no odometer: nothing invented', () => {
  const { vehicleStatus } = resMsg('status_latest_ev6').vehicleStatusInfo;
  const s = snapshotFromStatus({ vehicleStatus });
  assert.equal(s.odometerKm, undefined);
  assert.equal(s.evBattery, 76);
});

test('CCS2 (Kia EV9 2024): the values hyundai_kia_connect_api reads', () => {
  const s = snapshotFromCcs2(resMsg('ccs2_latest_ev9').state.Vehicle);
  assert.equal(s.evBattery, 71);
  assert.equal(s.chargeLimitDc, 80);
  assert.equal(s.chargeLimitAc, 100);
  assert.equal(s.battery12v, 88);
  assert.equal(s.ignition, false);
  // `Lock: false` on every door means locked.
  assert.equal(s.locked, true);
  assert.equal(s.charging, false);
  assert.equal(s.plugged, false);
  assert.equal(s.evRangeKm, 290);
  assert.equal(s.odometerKm, 5200);
  assert.equal(s.climateOn, false);
  assert.equal(s.updatedAt, Date.UTC(2024, 8, 15, 14));
});

test('CCS2: an unreliable 12 V sensor is unknown, not 0 %', () => {
  const s = snapshotFromCcs2(resMsg('ccs2_latest_ev9_battery_sentinel').state.Vehicle);
  assert.equal(s.battery12v, undefined);
  assert.equal(s.evBattery, 71);
});

test('CCS2 plug-in hybrid (Kia Sportage PHEV): electric and total ranges apart', () => {
  const s = snapshotFromCcs2(resMsg('ccs2_latest_sportage_phev').state.Vehicle);
  assert.equal(s.evBattery, 77);
  assert.equal(s.battery12v, 90);
  assert.equal(s.locked, true);
  assert.equal(s.charging, false);
  assert.equal(s.plugged, false);
  assert.equal(s.evRangeKm, 47);
  assert.equal(s.totalRangeKm, 600);
});

test('CCS2: one unlocked door unlocks the car, one open window shows', () => {
  const tree = resMsg('ccs2_latest_ev9').state.Vehicle;
  tree.Cabin.Door.Row2.Left.Lock = true;
  tree.Cabin.Window.Row1.Passenger.Open = 1;
  tree.Body.Trunk.Open = true;
  tree.Green.ChargingInformation.Charging.RemainTime = 95;
  tree.Green.ChargingInformation.ConnectorFastening.State = 1;
  tree.Cabin.HVAC.Row1.Driver.Blower.SpeedLevel = 3;
  tree.Cabin.HVAC.OutsideTemperature = { Value: 12.5, Unit: 0 };
  const s = snapshotFromCcs2(tree);
  assert.equal(s.locked, false);
  assert.equal(s.windowOpen, true);
  assert.equal(s.doorOpen, true);
  assert.equal(s.charging, true);
  assert.equal(s.chargeRemainingMin, 95);
  assert.equal(s.plugged, true);
  assert.equal(s.climateOn, true);
  assert.equal(s.outsideTempC, 12.5);
});

test('a combustion car: fuel range, open trunk, no battery feature', () => {
  const s = snapshotFromStatus(resMsg('status_latest_ice').vehicleStatusInfo);
  assert.equal(s.totalRangeKm, 512);
  assert.equal(s.evBattery, undefined);
  assert.equal(s.doorOpen, true);
  assert.equal(s.locked, false);
  const gladys = createFakeGladys();
  const device = buildVehicleDevice(gladys, I30, { language: 'en', brand: 'hyundai' });
  const keys = device.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(!keys.includes(F.BATTERY_LEVEL));
  assert.ok(!keys.includes(F.CHARGING));
  const range = device.features.find((f) => f.external_id.endsWith(':range'));
  assert.equal(range.category, 'distance-sensor');
  assert.equal(device.name, 'Old i30');
});

test('device per car: keyed on the VIN, features by protocol and drive train', () => {
  const gladys = createFakeGladys();
  const ioniq = buildVehicleDevice(gladys, IONIQ5, { language: 'fr', brand: 'hyundai' });
  assert.equal(ioniq.external_id, 'ext:hyundai-kia:vehicle:KMHTEST0FAKE00001');
  assert.equal(ioniq.name, 'Hyundai IONIQ 5');
  assert.equal(ioniq.model, 'IONIQ 5');
  assert.equal(ioniq.should_poll, false);
  const keys = (device) => device.features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(keys(ioniq).includes(F.CHARGE_LIMIT_AC));
  // Outside temperature: CCS2 only.
  assert.ok(!keys(ioniq).includes(F.OUTSIDE_TEMPERATURE));
  const ev9 = buildVehicleDevice(gladys, EV9, { language: 'en', brand: 'kia' });
  assert.ok(keys(ev9).includes(F.OUTSIDE_TEMPERATURE));
  assert.equal(ev9.name, 'Family EV9');
  const phev = buildVehicleDevice(gladys, SPORTAGE, { language: 'en', brand: 'kia' });
  assert.ok(keys(phev).includes(F.RANGE) && keys(phev).includes(F.TOTAL_RANGE));
  assert.equal(phev.features.find((f) => f.external_id.endsWith(':range')).name, 'Electric range');
  // Miles for a car that reports miles.
  const uk = buildVehicleDevice(gladys, IONIQ5, {
    language: 'en',
    brand: 'hyundai',
    distanceUnit: 'mi',
  });
  assert.equal(uk.features.find((f) => f.external_id.endsWith(':odometer')).unit, 'mile');
});

test('states: only known values, in the unit of the feature', () => {
  const gladys = createFakeGladys();
  const device = buildVehicleDevice(gladys, IONIQ5, { language: 'en', brand: 'hyundai' });
  const present = new Set(device.features.map((f) => f.external_id.split(':').at(-1)));
  const snapshot = {
    ...snapshotFromStatus(resMsg('status_latest_ev6').vehicleStatusInfo),
    targetTempC: 21,
  };
  const byKey = Object.fromEntries(
    vehicleStates(snapshot, () => 'km', present).map((s) => [s.key, s.value]),
  );
  assert.equal(byKey[F.BATTERY_LEVEL], 76);
  assert.equal(byKey[F.RANGE], 310);
  assert.equal(byKey[F.CHARGING_STATE], 4);
  assert.equal(byKey[F.LOCKED], 1);
  assert.equal(byKey[F.CHARGE_TIME_REMAINING], 0);
  assert.equal(byKey[F.TARGET_TEMPERATURE], 21);
  assert.equal(byKey[F.TOTAL_RANGE], undefined);
  const miles = Object.fromEntries(
    vehicleStates(snapshot, () => 'mile', present).map((s) => [s.key, s.value]),
  );
  assert.equal(miles[F.ODOMETER], 9466);
  // Plugged, then charging.
  const plugged = vehicleStates({ plugged: true, charging: false }, () => 'km', present);
  assert.equal(plugged.find((s) => s.key === F.CHARGING_STATE).value, 1);
  const charging = vehicleStates({ plugged: true, charging: true }, () => 'km', present);
  assert.equal(charging.find((s) => s.key === F.CHARGING_STATE).value, 0);
});

test('commands: the cloud orders, bounded values, the setpoint kept locally', () => {
  assert.deepEqual(vehicleCommand(F.CHARGING, 1), {
    order: 'startCharge',
    optimistic: { charging: true },
  });
  assert.equal(vehicleCommand(F.LOCKED, 0).order, 'unlock');
  const limit = vehicleCommand(F.CHARGE_LIMIT_AC, 84, { chargeLimitDc: 80 });
  assert.deepEqual(limit.args, { ac: 80, dc: 80 });
  const dc = vehicleCommand(F.CHARGE_LIMIT_DC, 100, {});
  assert.deepEqual(dc.args, { ac: 100, dc: 100 });
  const climate = vehicleCommand(F.CLIMATE, 1, { targetTempC: 23.5 }, { climateDuration: 15 });
  assert.deepEqual(climate.args, { temperature: 23.5, duration: 15 });
  const setpoint = vehicleCommand(F.TARGET_TEMPERATURE, 35);
  assert.equal(setpoint.local, true);
  assert.equal(setpoint.optimistic.targetTempC, 30);
  assert.equal(vehicleCommand(F.ODOMETER, 1), null);
  assert.equal(chargeLimit(20), 50);
  assert.equal(climateTemperature(21.3), 21.5);
  assert.throws(() => chargeLimit('abc'));
});

test('CCS2: any non-zero protocol flag, as hyundai_kia_connect_api reads it', () => {
  assert.equal(isCcs2({ ccuCCS2ProtocolSupport: 1 }), true);
  assert.equal(isCcs2({ ccuCCS2ProtocolSupport: '2' }), true);
  assert.equal(isCcs2({ ccuCCS2ProtocolSupport: 0 }), false);
  assert.equal(isCcs2({ ccuCCS2ProtocolSupport: null }), false);
  assert.equal(isCcs2({}), false);
});
