// -----------------------------------------------------------------------------
// Dashboard widget `vehicle` (SDK v0.14+, Gladys 5.1+): one car — two tiles,
// a status list, and up to four buttons (climate, charging, locks, refresh).
//
// The tiles are bound to the device features once the car is added to Gladys
// (they then move with every published state and follow the viewer's units);
// before that they show the last known value. The status rows and the button
// labels are computed here: the runtime nudges the widget when they change
// (src/hyundaiKia.js), the TTL is a safety net.
// Budget of the core: 8 components, 1 status, 4 buttons, 2 texts.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { VEHICLE_FEATURES, isElectric } from './devices/vehicle.js';
import { ACTION_RESULTS } from './bluelink/constants.js';
import { STATUS_MESSAGES, WIDGET_KEYS } from './hyundaiKia.js';
import { round } from './units.js';

const pickDevice = {
  en: 'Choose a vehicle in the widget settings.',
  fr: 'Choisissez un véhicule dans les réglages du widget.',
};

function message(text) {
  return { ttl_seconds: 300, components: [{ type: 'text', variant: 'body', text }] };
}

const percent = (value) => (Number.isFinite(value) ? `${Math.round(value)} %` : '—');
const onOff = (value, on, off) => (value === true ? on : value === false ? off : '—');

/** "11/10 14:05" / "10/11 2:05 PM": when the car last sent its state. */
export function formatUpdated(ms, timeZone) {
  if (!Number.isFinite(ms)) return '—';
  const format = (locale) =>
    new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(ms));
  return { en: format('en-GB'), fr: format('fr-FR') };
}

function chargeRow(snapshot) {
  const label = { en: 'Charging', fr: 'Charge' };
  if (snapshot.charging === true) {
    const minutes = snapshot.chargeRemainingMin;
    const left =
      Number.isFinite(minutes) && minutes > 0
        ? {
            en: `Charging, ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} left`,
            fr: `En charge, reste ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`,
          }
        : { en: 'Charging', fr: 'En charge' };
    return { label, icon: 'zap', value: left, color: WIDGET_COLORS.SUCCESS };
  }
  if (snapshot.plugged === true) {
    return {
      label,
      icon: 'battery',
      value: { en: 'Plugged in', fr: 'Branchée' },
      color: WIDGET_COLORS.INFO,
    };
  }
  if (snapshot.plugged === false) {
    return {
      label,
      icon: 'battery',
      value: { en: 'Unplugged', fr: 'Débranchée' },
      color: WIDGET_COLORS.NEUTRAL,
    };
  }
  return { label, icon: 'battery', value: '—', color: WIDGET_COLORS.NEUTRAL };
}

function vehicleContent(view, { timeZone } = {}) {
  const { device, created, snapshot, info } = view;
  const electric = isElectric(info);
  const ref = (key) => `${device.external_id}:${key}`;
  const createdIds = new Set((created?.features ?? []).map((f) => f.external_id));
  // A tile bound to a feature Gladys does not have shows nothing: inline value then.
  const tile = (key, label, icon, value, unit) =>
    createdIds.has(ref(key))
      ? { type: 'value', label, icon, device_feature: ref(key) }
      : {
          type: 'value',
          label,
          icon,
          value: value ?? '—',
          ...(value !== null && unit ? { unit } : {}),
        };
  const distanceUnit = snapshot.distanceUnit === 'mi' ? 'mi' : 'km';
  const toUnit = (km) =>
    Number.isFinite(km) ? round(distanceUnit === 'mi' ? km / 1.609344 : km) : null;

  const components = electric
    ? [
        tile(
          VEHICLE_FEATURES.BATTERY_LEVEL,
          { en: 'Battery', fr: 'Batterie' },
          'battery',
          round(snapshot.evBattery),
          '%',
        ),
        tile(
          VEHICLE_FEATURES.RANGE,
          { en: 'Range', fr: 'Autonomie' },
          'navigation',
          toUnit(snapshot.evRangeKm),
          distanceUnit,
        ),
      ]
    : [
        tile(
          VEHICLE_FEATURES.RANGE,
          { en: 'Range', fr: 'Autonomie' },
          'navigation',
          toUnit(snapshot.totalRangeKm),
          distanceUnit,
        ),
        tile(
          VEHICLE_FEATURES.ODOMETER,
          { en: 'Odometer', fr: 'Kilométrage' },
          'activity',
          toUnit(snapshot.odometerKm),
          distanceUnit,
        ),
      ];

  const items = [];
  if (electric) {
    items.push(chargeRow(snapshot), {
      label: { en: 'Charge limit', fr: 'Limite de charge' },
      icon: 'sliders',
      value: percent(snapshot.chargeLimitAc),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  items.push(
    {
      label: { en: 'Climate', fr: 'Climatisation' },
      icon: 'wind',
      value: onOff(
        snapshot.climateOn,
        { en: 'On', fr: 'En marche' },
        {
          en: `Off (set to ${snapshot.targetTempC} °C)`,
          fr: `Arrêtée (consigne ${String(snapshot.targetTempC).replace('.', ',')} °C)`,
        },
      ),
      color: snapshot.climateOn ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    },
    {
      label: { en: 'Doors', fr: 'Portes' },
      icon: snapshot.locked === false ? 'unlock' : 'lock',
      value: onOff(
        snapshot.locked,
        { en: 'Locked', fr: 'Verrouillées' },
        { en: 'Unlocked', fr: 'Déverrouillées' },
      ),
      color: snapshot.locked === false ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
    },
  );
  if (snapshot.doorOpen === true || snapshot.windowOpen === true) {
    items.push({
      label: { en: 'Openings', fr: 'Ouvrants' },
      icon: 'alert-triangle',
      value:
        snapshot.doorOpen === true
          ? { en: 'Door, trunk or hood open', fr: 'Portière, coffre ou capot ouvert' }
          : { en: 'Window open', fr: 'Fenêtre ouverte' },
      color: WIDGET_COLORS.WARNING,
    });
  }
  items.push({
    label: { en: 'Last update', fr: 'Dernier relevé' },
    icon: 'clock',
    value: formatUpdated(snapshot.updatedAt, timeZone),
    color: WIDGET_COLORS.NEUTRAL,
  });
  components.push({ type: 'status', items });

  // Buttons: one per order, labelled with what a tap does now.
  components.push(
    snapshot.climateOn
      ? {
          type: 'button',
          label: { en: 'Stop climate', fr: 'Arrêter la clim' },
          icon: 'wind',
          action: { key: 'climate_off' },
        }
      : {
          type: 'button',
          label: { en: 'Start climate', fr: 'Lancer la clim' },
          icon: 'wind',
          action: { key: 'climate_on' },
        },
  );
  if (electric && snapshot.charging === true) {
    components.push({
      type: 'button',
      label: { en: 'Stop charging', fr: 'Arrêter la charge' },
      icon: 'zap-off',
      action: { key: 'charge_stop' },
    });
  } else if (electric && snapshot.plugged === true) {
    components.push({
      type: 'button',
      label: { en: 'Start charging', fr: 'Lancer la charge' },
      icon: 'zap',
      action: { key: 'charge_start' },
    });
  }
  components.push(
    snapshot.locked === false
      ? {
          type: 'button',
          label: { en: 'Lock', fr: 'Verrouiller' },
          icon: 'lock',
          action: { key: 'lock' },
        }
      : {
          type: 'button',
          label: { en: 'Unlock', fr: 'Déverrouiller' },
          icon: 'unlock',
          style: 'danger',
          // A dashboard can hang on a wall: unlocking asks first.
          action: { key: 'unlock', confirm: true },
        },
    {
      type: 'button',
      label: { en: 'Refresh', fr: 'Actualiser' },
      icon: 'refresh-cw',
      // Wakes the car: asks first.
      action: { key: 'refresh', confirm: true },
    },
  );
  return { ttl_seconds: 300, components };
}

// Widget action key → [feature, value, toast].
const VEHICLE_ACTIONS = {
  climate_on: [VEHICLE_FEATURES.CLIMATE, 1, { en: 'Climate started', fr: 'Climatisation lancée' }],
  climate_off: [
    VEHICLE_FEATURES.CLIMATE,
    0,
    { en: 'Climate stopped', fr: 'Climatisation arrêtée' },
  ],
  charge_start: [VEHICLE_FEATURES.CHARGING, 1, { en: 'Charging started', fr: 'Charge lancée' }],
  charge_stop: [VEHICLE_FEATURES.CHARGING, 0, { en: 'Charging stopped', fr: 'Charge arrêtée' }],
  lock: [VEHICLE_FEATURES.LOCKED, 1, { en: 'Vehicle locked', fr: 'Véhicule verrouillé' }],
  unlock: [VEHICLE_FEATURES.LOCKED, 0, { en: 'Vehicle unlocked', fr: 'Véhicule déverrouillé' }],
};

/**
 * Widgets, keyed like the manifest. `runtime` is src/hyundaiKia.js.
 * A widget action resolves a bilingual toast, even on failure: a thrown error
 * reaches the screen as one plain string.
 */
export function createWidgets(runtime, { timeZone = process.env.TZ } = {}) {
  return {
    [WIDGET_KEYS.VEHICLE]: {
      async get({ settings }) {
        const view = settings?.device ? runtime.vehicleView(settings.device) : null;
        if (!view) {
          return message(
            settings?.device
              ? {
                  en: 'This device is not a Hyundai or Kia vehicle.',
                  fr: "Cet appareil n'est pas un véhicule Hyundai ou Kia.",
                }
              : pickDevice,
          );
        }
        return vehicleContent(view, { timeZone });
      },
      async action({ actionKey, settings }) {
        try {
          if (actionKey === 'refresh') {
            await runtime.forceRefresh(settings?.device);
            return { en: 'Vehicle state refreshed', fr: 'État du véhicule actualisé' };
          }
          const order = VEHICLE_ACTIONS[actionKey];
          if (!order) throw new Error(`Unknown action: ${actionKey}`);
          const [feature, value, toast] = order;
          const result = await runtime.order(settings?.device, feature, value);
          if (result === ACTION_RESULTS.SUCCESS) return toast;
          if (result === ACTION_RESULTS.FAILED) return STATUS_MESSAGES.failed;
          return STATUS_MESSAGES.noAnswer;
        } catch (err) {
          if (err.text) return err.text;
          throw err;
        }
      },
    },
  };
}

export { vehicleContent };
