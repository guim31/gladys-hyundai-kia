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

export const pickDevice = {
  en: 'Choose a vehicle in the widget settings.',
  fr: 'Choisissez un véhicule dans les réglages du widget.',
  de: 'Wähle in den Widget-Einstellungen ein Fahrzeug.',
  es: 'Elija un vehículo en los ajustes del widget.',
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
  return { en: format('en-GB'), fr: format('fr-FR'), de: format('de-DE'), es: format('es-ES') };
}

function chargeRow(snapshot) {
  const label = { en: 'Charging', fr: 'Charge', de: 'Laden', es: 'Carga' };
  if (snapshot.charging === true) {
    const minutes = snapshot.chargeRemainingMin;
    const left =
      Number.isFinite(minutes) && minutes > 0
        ? {
            en: `Charging, ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} left`,
            fr: `En charge, reste ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`,
            de: `Lädt, noch ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`,
            es: `Cargando, quedan ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`,
          }
        : { en: 'Charging', fr: 'En charge', de: 'Lädt', es: 'Cargando' };
    return { label, icon: 'zap', value: left, color: WIDGET_COLORS.SUCCESS };
  }
  if (snapshot.plugged === true) {
    return {
      label,
      icon: 'battery',
      value: { en: 'Plugged in', fr: 'Branchée', de: 'Angeschlossen', es: 'Enchufado' },
      color: WIDGET_COLORS.INFO,
    };
  }
  if (snapshot.plugged === false) {
    return {
      label,
      icon: 'battery',
      value: { en: 'Unplugged', fr: 'Débranchée', de: 'Nicht angeschlossen', es: 'Desenchufado' },
      color: WIDGET_COLORS.NEUTRAL,
    };
  }
  return { label, icon: 'battery', value: '—', color: WIDGET_COLORS.NEUTRAL };
}

// Status row of a command refusal the user must fix (40 characters at most).
export const COMMAND_ISSUES = {
  pinMissing: {
    en: 'PIN to enter in the configuration',
    fr: 'Code PIN à saisir (configuration)',
    de: 'PIN in der Konfiguration eingeben',
    es: 'Introduzca el PIN (configuración)',
  },
  pin: {
    en: 'PIN refused, check the configuration',
    fr: 'Code PIN refusé (configuration)',
    de: 'PIN abgelehnt, Konfiguration prüfen',
    es: 'PIN rechazado, revise la configuración',
  },
};

function vehicleContent(view, { timeZone } = {}) {
  const { device, created, snapshot, info, commandIssue } = view;
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
          { en: 'Battery', fr: 'Batterie', de: 'Batterie', es: 'Batería' },
          'battery',
          round(snapshot.evBattery),
          '%',
        ),
        tile(
          VEHICLE_FEATURES.RANGE,
          { en: 'Range', fr: 'Autonomie', de: 'Reichweite', es: 'Autonomía' },
          'navigation',
          toUnit(snapshot.evRangeKm),
          distanceUnit,
        ),
      ]
    : [
        tile(
          VEHICLE_FEATURES.RANGE,
          { en: 'Range', fr: 'Autonomie', de: 'Reichweite', es: 'Autonomía' },
          'navigation',
          toUnit(snapshot.totalRangeKm),
          distanceUnit,
        ),
        tile(
          VEHICLE_FEATURES.ODOMETER,
          { en: 'Odometer', fr: 'Kilométrage', de: 'Kilometerstand', es: 'Kilometraje' },
          'activity',
          toUnit(snapshot.odometerKm),
          distanceUnit,
        ),
      ];

  const items = [];
  if (electric) {
    items.push(chargeRow(snapshot), {
      label: { en: 'Charge limit', fr: 'Limite de charge', de: 'Ladelimit', es: 'Límite de carga' },
      icon: 'sliders',
      value: percent(snapshot.chargeLimitAc),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  items.push(
    {
      label: { en: 'Climate', fr: 'Climatisation', de: 'Klimatisierung', es: 'Climatización' },
      icon: 'wind',
      value: onOff(
        snapshot.climateOn,
        { en: 'On', fr: 'En marche', de: 'Ein', es: 'Encendida' },
        {
          en: `Off (set to ${snapshot.targetTempC} °C)`,
          fr: `Arrêtée (consigne ${String(snapshot.targetTempC).replace('.', ',')} °C)`,
          de: `Aus (Soll ${String(snapshot.targetTempC).replace('.', ',')} °C)`,
          es: `Apagada (consigna ${String(snapshot.targetTempC).replace('.', ',')} °C)`,
        },
      ),
      color: snapshot.climateOn ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    },
    {
      label: { en: 'Doors', fr: 'Portes', de: 'Türen', es: 'Puertas' },
      icon: snapshot.locked === false ? 'unlock' : 'lock',
      value: onOff(
        snapshot.locked,
        { en: 'Locked', fr: 'Verrouillées', de: 'Verriegelt', es: 'Bloqueadas' },
        { en: 'Unlocked', fr: 'Déverrouillées', de: 'Entriegelt', es: 'Desbloqueadas' },
      ),
      color: snapshot.locked === false ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
    },
  );
  if (snapshot.doorOpen === true || snapshot.windowOpen === true) {
    items.push({
      label: { en: 'Openings', fr: 'Ouvrants', de: 'Öffnungen', es: 'Aperturas' },
      icon: 'alert-triangle',
      value:
        snapshot.doorOpen === true
          ? {
              en: 'Door, trunk or hood open',
              fr: 'Portière, coffre ou capot ouvert',
              de: 'Tür, Kofferraum oder Motorhaube offen',
              es: 'Puerta, maletero o capó abierto',
            }
          : {
              en: 'Window open',
              fr: 'Fenêtre ouverte',
              de: 'Fenster offen',
              es: 'Ventanilla abierta',
            },
      color: WIDGET_COLORS.WARNING,
    });
  }
  if (COMMAND_ISSUES[commandIssue]) {
    items.push({
      label: { en: 'Commands', fr: 'Commandes', de: 'Befehle', es: 'Comandos' },
      icon: 'alert-octagon',
      value: COMMAND_ISSUES[commandIssue],
      color: WIDGET_COLORS.DANGER,
    });
  }
  items.push({
    label: {
      en: 'Last update',
      fr: 'Dernier relevé',
      de: 'Letzte Abfrage',
      es: 'Última actualización',
    },
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
          label: { en: 'Stop climate', fr: 'Arrêter la clim', de: 'Klima aus', es: 'Parar clima' },
          icon: 'wind',
          action: { key: 'climate_off' },
        }
      : {
          type: 'button',
          label: { en: 'Start climate', fr: 'Lancer la clim', de: 'Klima an', es: 'Iniciar clima' },
          icon: 'wind',
          action: { key: 'climate_on' },
        },
  );
  if (electric && snapshot.charging === true) {
    components.push({
      type: 'button',
      label: {
        en: 'Stop charging',
        fr: 'Arrêter la charge',
        de: 'Laden stoppen',
        es: 'Parar carga',
      },
      icon: 'zap-off',
      action: { key: 'charge_stop' },
    });
  } else if (electric && snapshot.plugged === true) {
    components.push({
      type: 'button',
      label: {
        en: 'Start charging',
        fr: 'Lancer la charge',
        de: 'Laden starten',
        es: 'Iniciar carga',
      },
      icon: 'zap',
      action: { key: 'charge_start' },
    });
  }
  components.push(
    snapshot.locked === false
      ? {
          type: 'button',
          label: { en: 'Lock', fr: 'Verrouiller', de: 'Verriegeln', es: 'Bloquear' },
          icon: 'lock',
          action: { key: 'lock' },
        }
      : {
          type: 'button',
          label: { en: 'Unlock', fr: 'Déverrouiller', de: 'Entriegeln', es: 'Desbloquear' },
          icon: 'unlock',
          style: 'danger',
          // A dashboard can hang on a wall: unlocking asks first.
          action: { key: 'unlock', confirm: true },
        },
    {
      type: 'button',
      label: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
      icon: 'refresh-cw',
      // Wakes the car: asks first.
      action: { key: 'refresh', confirm: true },
    },
  );
  return { ttl_seconds: 300, components };
}

// Widget action key → [feature, value, toast].
export const VEHICLE_ACTIONS = {
  climate_on: [
    VEHICLE_FEATURES.CLIMATE,
    1,
    {
      en: 'Climate started',
      fr: 'Climatisation lancée',
      de: 'Klimatisierung gestartet',
      es: 'Climatización iniciada',
    },
  ],
  climate_off: [
    VEHICLE_FEATURES.CLIMATE,
    0,
    {
      en: 'Climate stopped',
      fr: 'Climatisation arrêtée',
      de: 'Klimatisierung gestoppt',
      es: 'Climatización detenida',
    },
  ],
  charge_start: [
    VEHICLE_FEATURES.CHARGING,
    1,
    { en: 'Charging started', fr: 'Charge lancée', de: 'Laden gestartet', es: 'Carga iniciada' },
  ],
  charge_stop: [
    VEHICLE_FEATURES.CHARGING,
    0,
    { en: 'Charging stopped', fr: 'Charge arrêtée', de: 'Laden gestoppt', es: 'Carga detenida' },
  ],
  lock: [
    VEHICLE_FEATURES.LOCKED,
    1,
    {
      en: 'Vehicle locked',
      fr: 'Véhicule verrouillé',
      de: 'Fahrzeug verriegelt',
      es: 'Vehículo bloqueado',
    },
  ],
  unlock: [
    VEHICLE_FEATURES.LOCKED,
    0,
    {
      en: 'Vehicle unlocked',
      fr: 'Véhicule déverrouillé',
      de: 'Fahrzeug entriegelt',
      es: 'Vehículo desbloqueado',
    },
  ],
};

/**
 * Widgets, keyed like the manifest. `runtime` is src/hyundaiKia.js.
 * A widget action resolves its success toast (multi-language), and throws on
 * failure: the core (5.1.4) then shows "Action failed — <message>" in red,
 * the message being one plain string. A widget action does not carry the
 * viewer's language, a widget read does: the last one read is used.
 */
export function createWidgets(runtime, { timeZone = process.env.TZ } = {}) {
  let language = 'en';
  const fail = (text) => new Error(text[language] ?? text.en);
  return {
    [WIDGET_KEYS.VEHICLE]: {
      async get({ settings, language: viewer } = {}) {
        if (typeof viewer === 'string' && viewer) language = viewer.slice(0, 2);
        const view = settings?.device ? runtime.vehicleView(settings.device) : null;
        if (!view) {
          return message(
            settings?.device
              ? {
                  en: 'This device is not a Hyundai or Kia vehicle.',
                  fr: "Cet appareil n'est pas un véhicule Hyundai ou Kia.",
                  de: 'Dieses Gerät ist kein Hyundai- oder Kia-Fahrzeug.',
                  es: 'Este dispositivo no es un vehículo Hyundai o Kia.',
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
            return {
              en: 'Vehicle state refreshed',
              fr: 'État du véhicule actualisé',
              de: 'Fahrzeugzustand aktualisiert',
              es: 'Estado del vehículo actualizado',
            };
          }
          const order = VEHICLE_ACTIONS[actionKey];
          if (!order) throw new Error(`Unknown action: ${actionKey}`);
          const [feature, value, toast] = order;
          const result = await runtime.order(settings?.device, feature, value);
          if (result === ACTION_RESULTS.SUCCESS) return toast;
          if (result === ACTION_RESULTS.FAILED) throw fail(STATUS_MESSAGES.failed);
          // Not a failure: the car may still carry it out.
          return STATUS_MESSAGES.noAnswer;
        } catch (err) {
          if (err.text) throw fail(err.text);
          throw err;
        }
      },
    },
  };
}

export { vehicleContent };
