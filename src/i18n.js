// -----------------------------------------------------------------------------
// Texts that leave the container.
//
// A `device` integration does not receive the language of the user (a widget
// request does): device and feature names follow the `language` setting of the
// integration, and are frozen by Gladys once the device is created. Widget
// contents and action messages use multi-language objects instead, so the
// core picks the viewer's language.
// -----------------------------------------------------------------------------

const TEXTS = {
  batteryLevel: { en: 'Battery level', fr: 'Niveau de batterie' },
  range: { en: 'Range', fr: 'Autonomie' },
  evRange: { en: 'Electric range', fr: 'Autonomie électrique' },
  totalRange: { en: 'Total range', fr: 'Autonomie totale' },
  chargingState: { en: 'Charging state', fr: 'État de charge' },
  charging: { en: 'Charging', fr: 'Charge' },
  plugged: { en: 'Plugged in', fr: 'Branchée' },
  chargeLimitAc: { en: 'Charge limit (AC)', fr: 'Limite de charge (AC)' },
  chargeLimitDc: { en: 'Charge limit (DC)', fr: 'Limite de charge (DC)' },
  chargeTimeRemaining: { en: 'Charging time remaining', fr: 'Temps de charge restant' },
  climate: { en: 'Climate', fr: 'Climatisation' },
  targetTemp: { en: 'Climate set temperature', fr: 'Consigne de climatisation' },
  outsideTemp: { en: 'Outside temperature', fr: 'Température extérieure' },
  locked: { en: 'Locked', fr: 'Verrouillage' },
  doorOpen: { en: 'Door, trunk or hood open', fr: 'Portière, coffre ou capot ouvert' },
  windowOpen: { en: 'Window open', fr: 'Fenêtre ouverte' },
  odometer: { en: 'Odometer', fr: 'Kilométrage' },
  battery12v: { en: '12 V battery', fr: 'Batterie 12 V' },
  ignition: { en: 'Ignition on', fr: 'Contact mis' },
};

/** Text in one language (device and feature names). */
export function t(language, key) {
  const entry = TEXTS[key];
  if (!entry) throw new Error(`Unknown text key: ${key}`);
  return entry[language] ?? entry.en;
}

/** Both languages, for the multi-language objects the core localizes. */
export function both(key) {
  const entry = TEXTS[key];
  if (!entry) throw new Error(`Unknown text key: ${key}`);
  return { ...entry };
}
