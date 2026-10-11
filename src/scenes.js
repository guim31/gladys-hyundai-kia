// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, SDK v0.14+, Gladys 5.1+).
//
// What a scene can already do through the device features (start charging,
// set a charge limit, lock...) is not repeated here: only what no feature
// carries.
//   - `refresh_vehicle` wakes the car and reads its state, for a scene that
//     must decide on fresh values (the cached state can be hours old);
//   - `start_climate` starts the climate with its own temperature and
//     duration, without changing the setpoint kept for the dashboard.
//
// Fields arrive resolved and validated by the core, without defaults (a
// manifest default is not applied to an action): every field is optional
// here. Throwing fails this action only, the scene goes on.
// -----------------------------------------------------------------------------

import { round } from './units.js';

export const SCENE_ACTION_KEYS = {
  REFRESH_VEHICLE: 'refresh_vehicle',
  START_CLIMATE: 'start_climate',
};

export function createSceneActions(runtime) {
  return {
    async [SCENE_ACTION_KEYS.REFRESH_VEHICLE]({ fields }) {
      const snapshot = await runtime.forceRefresh(fields.device);
      const outputs = {};
      if (Number.isFinite(snapshot.evBattery)) outputs.battery_level = round(snapshot.evBattery);
      const range = Number.isFinite(snapshot.evRangeKm)
        ? snapshot.evRangeKm
        : snapshot.totalRangeKm;
      if (Number.isFinite(range)) outputs.range_km = round(range);
      return outputs;
    },

    async [SCENE_ACTION_KEYS.START_CLIMATE]({ fields }) {
      const { temperature } = await runtime.startClimate(fields.device, {
        temperature: fields.temperature,
        duration: fields.duration,
      });
      return { temperature };
    },
  };
}
