// -----------------------------------------------------------------------------
// Unit handling.
//
// The snapshot keeps distances in km and temperatures in °C. Distances are
// published in the unit the car itself reports (km in continental Europe,
// miles in the United Kingdom); temperatures always in °C (the European cloud
// takes and gives °C). Gladys converts to each viewer's preference on the
// dashboard, scenes compare the published value.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';

const KM_PER_MILE = 1.609344;

/** Round to `decimals` places, keeping null/undefined as null. */
export function round(value, decimals = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A distance read in km, in the published unit. */
export function distanceIn(unit, km) {
  if (km === null || km === undefined) return null;
  return unit === DEVICE_FEATURE_UNITS.MILE ? km / KM_PER_MILE : km;
}
