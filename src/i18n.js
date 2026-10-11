// -----------------------------------------------------------------------------
// Texts that leave the container.
//
// A `device` integration does not receive the language of the user (a widget
// request does): device and feature names follow the `language` setting of the
// integration, and are frozen by Gladys once the device is created. Widget
// contents and action messages use multi-language objects instead, so the
// core picks the viewer's language.
// -----------------------------------------------------------------------------

export const TEXTS = {
  batteryLevel: {
    en: 'Battery level',
    fr: 'Niveau de batterie',
    de: 'Batteriestand',
    es: 'Nivel de batería',
  },
  range: { en: 'Range', fr: 'Autonomie', de: 'Reichweite', es: 'Autonomía' },
  evRange: {
    en: 'Electric range',
    fr: 'Autonomie électrique',
    de: 'Elektrische Reichweite',
    es: 'Autonomía eléctrica',
  },
  totalRange: {
    en: 'Total range',
    fr: 'Autonomie totale',
    de: 'Gesamtreichweite',
    es: 'Autonomía total',
  },
  chargingState: {
    en: 'Charging state',
    fr: 'État de charge',
    de: 'Ladezustand',
    es: 'Estado de carga',
  },
  charging: { en: 'Charging', fr: 'Charge', de: 'Laden', es: 'Carga' },
  plugged: { en: 'Plugged in', fr: 'Branchée', de: 'Angeschlossen', es: 'Enchufado' },
  chargeLimitAc: {
    en: 'Charge limit (AC)',
    fr: 'Limite de charge (AC)',
    de: 'Ladelimit (AC)',
    es: 'Límite de carga (AC)',
  },
  chargeLimitDc: {
    en: 'Charge limit (DC)',
    fr: 'Limite de charge (DC)',
    de: 'Ladelimit (DC)',
    es: 'Límite de carga (DC)',
  },
  chargeTimeRemaining: {
    en: 'Charging time remaining',
    fr: 'Temps de charge restant',
    de: 'Verbleibende Ladezeit',
    es: 'Tiempo de carga restante',
  },
  climate: { en: 'Climate', fr: 'Climatisation', de: 'Klimatisierung', es: 'Climatización' },
  targetTemp: {
    en: 'Climate set temperature',
    fr: 'Consigne de climatisation',
    de: 'Klima-Solltemperatur',
    es: 'Consigna de climatización',
  },
  outsideTemp: {
    en: 'Outside temperature',
    fr: 'Température extérieure',
    de: 'Außentemperatur',
    es: 'Temperatura exterior',
  },
  locked: { en: 'Locked', fr: 'Verrouillage', de: 'Verriegelung', es: 'Bloqueo' },
  doorOpen: {
    en: 'Door, trunk or hood open',
    fr: 'Portière, coffre ou capot ouvert',
    de: 'Tür, Kofferraum oder Motorhaube offen',
    es: 'Puerta, maletero o capó abierto',
  },
  windowOpen: {
    en: 'Window open',
    fr: 'Fenêtre ouverte',
    de: 'Fenster offen',
    es: 'Ventanilla abierta',
  },
  odometer: { en: 'Odometer', fr: 'Kilométrage', de: 'Kilometerstand', es: 'Kilometraje' },
  battery12v: {
    en: '12 V battery',
    fr: 'Batterie 12 V',
    de: '12-V-Batterie',
    es: 'Batería de 12 V',
  },
  ignition: { en: 'Ignition on', fr: 'Contact mis', de: 'Zündung an', es: 'Contacto puesto' },
};

/** Text in one language (device and feature names). */
export function t(language, key) {
  const entry = TEXTS[key];
  if (!entry) throw new Error(`Unknown text key: ${key}`);
  return entry[language] ?? entry.en;
}

/** Every language, for the multi-language objects the core localizes. */
export function both(key) {
  const entry = TEXTS[key];
  if (!entry) throw new Error(`Unknown text key: ${key}`);
  return { ...entry };
}
