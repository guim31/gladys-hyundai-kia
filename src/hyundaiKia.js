// -----------------------------------------------------------------------------
// The integration's runtime: the account's cars, read from the Bluelink / Kia
// Connect cloud and published to Gladys (only what changed).
//
// Reads, cheapest first:
//   1. the state the car last sent to the cloud ("cached"), every
//      `refresh_minutes`: never wakes the car. A car sends its state when it
//      is switched off, while it charges, and after a command;
//   2. a forced refresh, which wakes the car's modem: only on request (scene
//      action, widget button) or every `force_refresh_hours` when the user
//      chose it, never at night. It drains the 12 V battery and counts in a
//      small daily quota.
// Commands answer at once with a message id; the car carries them out later,
// and their outcome is read from the account's notification records.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { forceRefreshMs, isConfigured, isDaytime, refreshMs } from './config.js';
import { ACTION_RESULTS, brandConstants } from './bluelink/constants.js';
import { ERROR_KINDS } from './bluelink/errors.js';
import { createHttp } from './bluelink/http.js';
import { createBluelinkClient } from './bluelink/client.js';
import {
  DEFAULT_CLIMATE_TEMP_C,
  VEHICLE_FEATURES,
  buildVehicleDevice,
  climateTemperature,
  isCcs2,
  snapshotFrom,
  vehicleCommand,
  vehicleIds,
  vehicleStates,
} from './devices/vehicle.js';

const MINUTE = 60 * 1000;
const VEHICLE_LIST_REFRESH_MS = 6 * 60 * MINUTE;
const RETRY_MS = 15 * MINUTE;
const RATE_LIMIT_BACKOFF_MS = 60 * MINUTE;
const ACTION_POLL_MS = 5000;
const ACTION_TIMEOUT_MS = 120 * 1000;
const READ_AFTER_COMMAND_MS = 30 * 1000;
const SETTLE_LIMIT_MS = 90 * 1000;
const MAX_STATES_PER_REQUEST = 100;
const WIDGET_NUDGE_MIN_INTERVAL_MS = 10 * 1000;

// Widget keys (manifest `widgets`), nudged when their computed rows change.
export const WIDGET_KEYS = { VEHICLE: 'vehicle' };

// Snapshot fields shown by the widget outside of device-bound tiles.
const WIDGET_FIELDS = [
  'charging',
  'plugged',
  'climateOn',
  'locked',
  'doorOpen',
  'windowOpen',
  'chargeLimitAc',
  'updatedAt',
  'targetTempC',
];

// Errors the user must fix: no retry until the configuration changes.
const BLOCKING_KINDS = new Set([ERROR_KINDS.AUTH, ERROR_KINDS.CONSENT, ERROR_KINDS.BLOCKED]);

export const STATUS_MESSAGES = {
  notConfigured: {
    en: 'Enter the e-mail address and password of your Bluelink or Kia Connect account.',
    fr: 'Saisissez l’adresse e-mail et le mot de passe de votre compte Bluelink ou Kia Connect.',
    de: 'Gib die E-Mail-Adresse und das Passwort deines Bluelink- oder Kia-Connect-Kontos ein.',
    es: 'Introduzca la dirección de correo electrónico y la contraseña de su cuenta Bluelink o Kia Connect.',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'The account refused the sign-in: check the brand, e-mail address and password, then save.',
    fr: 'Le compte a refusé la connexion : vérifiez la marque, l’adresse e-mail et le mot de passe, puis enregistrez.',
    de: 'Das Konto hat die Anmeldung abgelehnt: Prüfe Marke, E-Mail-Adresse und Passwort und speichere dann.',
    es: 'La cuenta ha rechazado el inicio de sesión: compruebe la marca, el correo electrónico y la contraseña, y luego guarde.',
  },
  [ERROR_KINDS.CONSENT]: {
    en: 'Your account asks you to accept new terms: sign in once in the official app, then save the configuration again.',
    fr: 'Votre compte demande d’accepter de nouvelles conditions : connectez-vous une fois dans l’application officielle, puis enregistrez à nouveau la configuration.',
    de: 'Dein Konto verlangt, neue Bedingungen zu akzeptieren: Melde dich einmal in der offiziellen App an und speichere dann die Konfiguration erneut.',
    es: 'Su cuenta le pide aceptar nuevas condiciones: inicie sesión una vez en la aplicación oficial y vuelva a guardar la configuración.',
  },
  [ERROR_KINDS.BLOCKED]: {
    en: 'The sign-in pages refused the connection (protection against repeated sign-ins). Wait a few hours, then save the configuration again.',
    fr: 'Les pages de connexion ont refusé la connexion (protection contre les connexions répétées). Patientez quelques heures, puis enregistrez à nouveau la configuration.',
    de: 'Die Anmeldeseiten haben die Verbindung abgelehnt (Schutz vor wiederholten Anmeldungen). Warte einige Stunden und speichere dann die Konfiguration erneut.',
    es: 'Las páginas de inicio de sesión han rechazado la conexión (protección contra inicios de sesión repetidos). Espere unas horas y vuelva a guardar la configuración.',
  },
  // The PIN was refused (a PIN is saved).
  [ERROR_KINDS.PIN]: {
    en: 'The PIN of your account was refused: check it in the configuration of the integration.',
    fr: 'Le code PIN de votre compte a été refusé : vérifiez-le dans la configuration de l’intégration.',
    de: 'Die PIN deines Kontos wurde abgelehnt: Prüfe sie in der Konfiguration der Integration.',
    es: 'Se ha rechazado el PIN de su cuenta: compruébelo en la configuración de la integración.',
  },
  // The car asked for the PIN, none is saved.
  pinMissing: {
    en: 'Enter the PIN of your account in the configuration of the integration: the car asks for it for remote commands.',
    fr: 'Saisissez le code PIN de votre compte dans la configuration de l’intégration : la voiture le demande pour les commandes à distance.',
    de: 'Gib die PIN deines Kontos in der Konfiguration der Integration ein: Das Auto verlangt sie für Fernbefehle.',
    es: 'Introduzca el PIN de su cuenta en la configuración de la integración: el coche lo pide para los comandos remotos.',
  },
  [ERROR_KINDS.RATE_LIMIT]: {
    en: 'The daily request quota of the account is spent: try again tomorrow.',
    fr: 'Le quota quotidien de requêtes du compte est épuisé : réessayez demain.',
    de: 'Das tägliche Anfragekontingent des Kontos ist aufgebraucht: Versuche es morgen erneut.',
    es: 'Se ha agotado la cuota diaria de solicitudes de la cuenta: vuelva a intentarlo mañana.',
  },
  [ERROR_KINDS.CAR_UNAVAILABLE]: {
    en: 'The car did not answer (no network where it is parked?).',
    fr: 'La voiture n’a pas répondu (pas de réseau là où elle est garée ?).',
    de: 'Das Auto hat nicht geantwortet (kein Netz dort, wo es parkt?).',
    es: 'El coche no ha respondido (¿sin cobertura donde está aparcado?).',
  },
  [ERROR_KINDS.UNSUPPORTED]: {
    en: 'This car does not support this command.',
    fr: 'Cette voiture ne prend pas en charge cette commande.',
    de: 'Dieses Auto unterstützt diesen Befehl nicht.',
    es: 'Este coche no admite este comando.',
  },
  [ERROR_KINDS.DUPLICATE]: {
    en: 'Another command is already running on this car: try again in a minute.',
    fr: 'Une autre commande est déjà en cours sur cette voiture : réessayez dans une minute.',
    de: 'Auf diesem Auto läuft bereits ein anderer Befehl: Versuche es in einer Minute erneut.',
    es: 'Ya hay otro comando en curso en este coche: vuelva a intentarlo dentro de un minuto.',
  },
  // Connection test: what it checks is the saved configuration, never the
  // form being edited (the core sends no config with an action).
  notSaved: {
    en: 'No account is saved yet: enter the e-mail address and password, save, then test again.',
    fr: 'Aucun compte n’est encore enregistré : saisissez l’adresse e-mail et le mot de passe, enregistrez, puis testez à nouveau.',
    de: 'Noch kein Konto gespeichert: Gib E-Mail-Adresse und Passwort ein, speichere und teste dann erneut.',
    es: 'Todavía no hay ninguna cuenta guardada: introduzca el correo electrónico y la contraseña, guarde y vuelva a probar.',
  },
  starting: {
    en: 'The integration is starting: try again in a few seconds.',
    fr: 'L’intégration démarre : réessayez dans quelques secondes.',
    de: 'Die Integration startet: Versuche es in ein paar Sekunden erneut.',
    es: 'La integración se está iniciando: vuelva a intentarlo dentro de unos segundos.',
  },
  unreachable: {
    en: 'The Bluelink / Kia Connect cloud is unreachable for now, retrying.',
    fr: 'Le cloud Bluelink / Kia Connect est injoignable pour le moment, nouvel essai en cours.',
    de: 'Die Bluelink-/Kia-Connect-Cloud ist gerade nicht erreichbar, neuer Versuch läuft.',
    es: 'La nube de Bluelink / Kia Connect no está disponible por ahora, nuevo intento en curso.',
  },
  failed: {
    en: 'The car reported that the command failed.',
    fr: 'La voiture a indiqué que la commande a échoué.',
    de: 'Das Auto hat gemeldet, dass der Befehl fehlgeschlagen ist.',
    es: 'El coche ha indicado que el comando ha fallado.',
  },
  noAnswer: {
    en: 'The command was sent, but the car has not confirmed it yet.',
    fr: 'La commande est envoyée, mais la voiture ne l’a pas encore confirmée.',
    de: 'Der Befehl wurde gesendet, aber das Auto hat ihn noch nicht bestätigt.',
    es: 'El comando se ha enviado, pero el coche aún no lo ha confirmado.',
  },
  // Connection status when the start fails (index.js).
  initFailed: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
    de: 'Initialisierung fehlgeschlagen, sieh in den Logs der Integration nach.',
    es: 'La inicialización ha fallado, consulte los registros de la integración.',
  },
  unknownVehicle: {
    en: 'Choose a Hyundai or Kia vehicle.',
    fr: 'Choisissez un véhicule Hyundai ou Kia.',
    de: 'Wähle ein Hyundai- oder Kia-Fahrzeug.',
    es: 'Elija un vehículo Hyundai o Kia.',
  },
};

/** An Error carrying a multi-language text, for action and widget toasts. */
export class UserError extends Error {
  constructor(text, kind) {
    super(text.en);
    this.text = text;
    if (kind) this.kind = kind;
  }
}

/**
 * A failed manifest action. Thrown, so Gladys shows it in red: the core
 * (5.1.4) relays the thrown `message` untouched to the browser, which picks
 * the user's language in a `{ en, fr, de, es }` object. A resolved action is always
 * shown as a success, there is no warning level. (SDK 0.14 has no such class.)
 */
export class ActionFailure extends Error {
  constructor(text) {
    super(text.en);
    this.message = text;
    this.text = text;
  }
}

/**
 * The multi-language error of a cloud failure, `null` when none fits.
 * @param {Error} err
 * @param {boolean} pinSaved whether the configuration holds a PIN
 */
function userTextOf(err, pinSaved) {
  if (err instanceof UserError) return err.text;
  if (err.kind === ERROR_KINDS.PIN && !pinSaved) return STATUS_MESSAGES.pinMissing;
  return (
    STATUS_MESSAGES[err.kind] ??
    (err.kind === ERROR_KINDS.NETWORK || err.kind === ERROR_KINDS.SERVER
      ? STATUS_MESSAGES.unreachable
      : null)
  );
}

function toUserError(err, pinSaved) {
  if (err instanceof UserError) return err;
  const text = userTextOf(err, pinSaved);
  return text ? new UserError(text, err.kind) : err;
}

/** The real Bluelink client of a configuration. */
export function defaultClientFactory(config, tokenStore) {
  return createBluelinkClient({
    constants: brandConstants(config.brand),
    http: createHttp(),
    credentials: {
      username: config.username,
      password: config.password,
      pin: config.pin,
      language: config.account_language,
    },
    tokenStore,
  });
}

export function createHyundaiKia({
  gladys,
  store,
  logger = createLogger({ name: 'hyundai-kia' }),
  clientFactory = defaultClientFactory,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let config = null;
  let client = null;
  let ticker = null;
  let blocked = null; // error kind that stops everything until the config changes
  let lastListAt = 0;
  let lastFailureAt = 0;
  let backoffUntil = 0;
  let publishedDevicesJson = null;
  let stopped = false;
  // What the user must fix before commands work (a STATUS_MESSAGES key):
  // shown by the widget, since a refused dashboard command only reaches the
  // core's logs. Cleared by the next accepted command or a new configuration.
  let commandIssue = null;
  const vehicles = new Map(); // vin → { info, ref, snapshot, lastReadAt, lastForcedAt, override, forcing }
  const published = new Map(); // feature external_id → serialized value
  const nudges = new Map(); // widget key → { at, timer }
  const background = new Set(); // command follow-ups in flight
  // Failures already logged (key → true): a failure that repeats every read
  // is logged once at warn level, then at debug level until it recovers.
  const failing = new Set();
  let statusSent = null; // last connection status Gladys accepted (serialized)
  let statusWanted = null; // last connection status asked for: [connected, message]

  // --- Helpers ---------------------------------------------------------------

  function createdDevice(externalId) {
    return (gladys.devices ?? []).find((device) => device.external_id === externalId);
  }

  function vehicleDevice(vehicle) {
    return buildVehicleDevice(gladys, vehicle.info, {
      language: config.language,
      brand: config.brand,
      distanceUnit: vehicle.snapshot.distanceUnit,
    });
  }

  // Unit and presence of a feature: the created device's (what Gladys stores
  // the values in), else the one the next discovery would publish.
  function featureResolver(built) {
    const created = createdDevice(built.external_id);
    const features = created?.features ?? built.features;
    const byKey = new Map(
      features.map((f) => [f.external_id.slice(built.external_id.length + 1), f]),
    );
    return { unitOf: (key) => byKey.get(key)?.unit, present: new Set(byKey.keys()) };
  }

  function findVehicle(deviceExternalId) {
    for (const vehicle of vehicles.values()) {
      if (vehicleIds(gladys, vehicle.info.vin).device === deviceExternalId) return vehicle;
    }
    return null;
  }

  function memoryOf(vin) {
    store.data.vehicles[vin] = store.data.vehicles[vin] ?? {};
    return store.data.vehicles[vin];
  }

  const pinSaved = () => Boolean(config?.pin);

  /** A command was refused (`err`) or accepted (no `err`). */
  function noteCommand(err) {
    let issue = commandIssue;
    if (!err) issue = null;
    else if (err.kind === ERROR_KINDS.PIN) issue = pinSaved() ? ERROR_KINDS.PIN : 'pinMissing';
    if (issue === commandIssue) return;
    commandIssue = issue;
    nudgeWidget(WIDGET_KEYS.VEHICLE);
  }

  // Every read reports the status: send it only when it changes. Reset when
  // Gladys reconnects (resync) or the runtime starts again.
  async function setStatus(connected, message) {
    statusWanted = [connected, message];
    const key = JSON.stringify([connected, message ?? null]);
    if (key === statusSent) return;
    try {
      await gladys.setConnectionStatus(connected, message);
      statusSent = key;
    } catch (err) {
      // Gladys unreachable: the SDK already logs its connection lifecycle.
      logger.debug(`Could not report the connection status: ${err.message}`);
    }
  }

  /** Log a failure once (warn), then at debug level while it repeats. */
  function logFailure(key, line) {
    if (failing.has(key)) {
      logger.debug(line);
      return;
    }
    failing.add(key);
    logger.warn(`${line} (logged once until it recovers)`);
  }

  /** One info line when a logged failure is over. */
  function logRecovery(key, line) {
    if (failing.delete(key)) logger.info(line);
  }

  // --- Publishing ------------------------------------------------------------

  /**
   * Publish the states whose value changed since the last accepted
   * publication. States of devices the user has not created yet are kept for
   * later: Gladys would drop them (they are re-sent by onDeviceCreated).
   */
  async function publishChanged(deviceExternalId, states, { force = false } = {}) {
    if (Array.isArray(gladys.devices) && !createdDevice(deviceExternalId)) return 0;
    const changed = [];
    for (const { key, value } of states) {
      const externalId = `${deviceExternalId}:${key}`;
      const serialized = JSON.stringify(value);
      if (!force && published.get(externalId) === serialized) continue;
      changed.push({ externalId, serialized, value });
    }
    for (let i = 0; i < changed.length; i += MAX_STATES_PER_REQUEST) {
      const batch = changed.slice(i, i + MAX_STATES_PER_REQUEST);
      try {
        await gladys.publishStates(
          batch.map(({ externalId, value }) => ({
            device_feature_external_id: externalId,
            state: value,
          })),
        );
        for (const { externalId, serialized } of batch) published.set(externalId, serialized);
      } catch (err) {
        // Not remembered: the next change (or reconnection) sends it again.
        logFailure('publish', `Publishing ${batch.length} state(s) failed: ${err.message}`);
        continue;
      }
      logRecovery('publish', 'Publishing states to Gladys works again');
    }
    return changed.length;
  }

  async function publishVehicle(vehicle, options) {
    const built = vehicleDevice(vehicle);
    const { unitOf, present } = featureResolver(built);
    return publishChanged(
      built.external_id,
      vehicleStates(vehicle.snapshot, unitOf, present),
      options,
    );
  }

  async function publishAll(options) {
    for (const vehicle of vehicles.values()) await publishVehicle(vehicle, options);
  }

  async function publishDevices({ force = false } = {}) {
    const devices = config ? [...vehicles.values()].map(vehicleDevice) : [];
    const json = JSON.stringify(devices);
    if (!force && json === publishedDevicesJson) return;
    await gladys.publishDiscoveredDevices(devices);
    publishedDevicesJson = json;
  }

  function nudgeWidget(key) {
    const entry = nudges.get(key) ?? { at: 0, timer: null };
    nudges.set(key, entry);
    if (entry.timer) return;
    const delay = entry.at + WIDGET_NUDGE_MIN_INTERVAL_MS - now();
    const fire = () => {
      entry.timer = null;
      entry.at = now();
      try {
        gladys.requestWidgetRefresh(key);
      } catch (err) {
        logger.debug(`Widget nudge skipped: ${err.message}`);
      }
    };
    if (delay <= 0) fire();
    else {
      // Trailing nudge: the last change inside the core's 10 s window still lands.
      entry.timer = setTimeout(fire, delay);
      entry.timer.unref?.();
    }
  }

  // --- Snapshots -------------------------------------------------------------

  async function applyVehicle(vehicle, changes) {
    const previous = vehicle.snapshot;
    const next = { ...previous, ...changes };
    vehicle.snapshot = next;
    if (previous.distanceUnit !== next.distanceUnit) {
      await publishDevices().catch((err) => logger.warn(err.message));
    }
    await publishVehicle(vehicle);
    if (WIDGET_FIELDS.some((f) => previous[f] !== next[f])) nudgeWidget(WIDGET_KEYS.VEHICLE);
  }

  /**
   * Fold a read into the snapshot. Values a confirmed command changed stay
   * until the car sends a state newer than the command: the cloud's copy can
   * lag behind it.
   */
  async function applyRead(vehicle, snapshot) {
    const override = vehicle.override;
    let merged = snapshot;
    if (override) {
      if (snapshot.updatedAt !== undefined && snapshot.updatedAt >= override.at) {
        vehicle.override = null;
      } else {
        merged = { ...snapshot, ...override.fields };
      }
    }
    await applyVehicle(vehicle, merged);
  }

  // --- Reads -----------------------------------------------------------------

  /**
   * Handle a read or command error; true when the runtime must stop.
   * `failureKey` marks a periodic read: its repeated failures are logged once.
   */
  async function handleError(err, context, failureKey = null) {
    if (BLOCKING_KINDS.has(err.kind)) {
      blocked = err.kind;
      logger.error(`${context}: ${err.message}`);
      await setStatus(false, STATUS_MESSAGES[err.kind]);
      stopTicker();
      return true;
    }
    if (err.kind === ERROR_KINDS.RATE_LIMIT) {
      backoffUntil = now() + RATE_LIMIT_BACKOFF_MS;
      logger.warn(`${context}: daily request quota spent, reads pause for an hour`);
      return false;
    }
    if (err.kind === ERROR_KINDS.NETWORK || err.kind === ERROR_KINDS.SERVER) {
      lastFailureAt = now();
      if (failureKey) logFailure('cloud', `${context}: ${err.message}`);
      else logger.warn(`${context}: ${err.message}`);
      await setStatus(false, STATUS_MESSAGES.unreachable);
      return false;
    }
    if (failureKey) logFailure(failureKey, `${context}: ${err.message}`);
    else logger.warn(`${context}: ${err.message}`);
    return false;
  }

  /** The cloud answered a periodic call: end of the logged outages. */
  function cloudAnswered(failureKey, label) {
    logRecovery('cloud', 'The Bluelink / Kia Connect cloud answers again');
    if (failureKey) logRecovery(failureKey, `${label}: works again`);
  }

  async function readVehicle(vehicle, { forced = false } = {}) {
    if (forced) vehicle.lastForcedAt = now();
    vehicle.lastReadAt = now();
    const raw = forced
      ? await client.forcedStatus(vehicle.ref, { wait })
      : await client.cachedStatus(vehicle.ref);
    await applyRead(vehicle, snapshotFrom(raw, vehicle.ref.ccs2));
    await setStatus(true);
  }

  async function safeRead(vehicle, options) {
    const label = `Reading ${vehicle.info.nickname || vehicle.info.vehicleName || 'a vehicle'}`;
    const failureKey = `read:${vehicle.info.vin}`;
    try {
      await readVehicle(vehicle, options);
    } catch (err) {
      await handleError(err, label, failureKey);
      return;
    }
    cloudAnswered(failureKey, label);
  }

  /** The account's cars; new ones appear in the Discovery screen. */
  async function discover() {
    let list;
    try {
      list = await client.vehicles();
      lastListAt = now();
    } catch (err) {
      await handleError(err, 'Listing the vehicles', 'list');
      return false;
    }
    cloudAnswered('list', 'Listing the vehicles');
    const seen = new Set();
    for (const info of list) {
      if (!info?.vin || !info?.vehicleId) continue;
      seen.add(info.vin);
      const existing = vehicles.get(info.vin);
      const ref = { id: info.vehicleId, ccs2: isCcs2(info) };
      if (existing) {
        existing.info = info;
        existing.ref = ref;
        continue;
      }
      const memory = memoryOf(info.vin);
      const vehicle = {
        info,
        ref,
        snapshot: { targetTempC: memory.targetTempC ?? DEFAULT_CLIMATE_TEMP_C },
        lastReadAt: 0,
        lastForcedAt: memory.lastForcedAt ?? 0,
        override: null,
        forcing: null,
      };
      vehicles.set(info.vin, vehicle);
      // The protocol decides whether commands need the PIN: worth a line.
      logger.info(
        `${info.nickname || info.vehicleName || 'Vehicle'}: ${
          ref.ccs2 ? 'CCS2 protocol, commands need the PIN' : 'original protocol'
        }`,
      );
      await safeRead(vehicle);
      if (blocked) return false;
    }
    for (const vin of vehicles.keys()) if (!seen.has(vin)) vehicles.delete(vin);
    await publishDevices();
    await setStatus(true);
    return true;
  }

  async function connect() {
    try {
      await client.connect();
    } catch (err) {
      await handleError(err, 'Signing in', 'sign-in');
      return false;
    }
    cloudAnswered('sign-in', 'Signing in');
    return discover();
  }

  async function tick() {
    if (!client || blocked || stopped) return;
    const t = now();
    if (t < backoffUntil) return;
    if (vehicles.size === 0 || t - lastListAt >= VEHICLE_LIST_REFRESH_MS) {
      if (lastFailureAt && t - lastFailureAt < RETRY_MS && vehicles.size === 0) return;
      await connect();
      if (blocked) return;
    }
    const refresh = refreshMs(config);
    const forceEvery = forceRefreshMs(config);
    for (const vehicle of vehicles.values()) {
      if (blocked || now() < backoffUntil) return;
      const forcedDue =
        forceEvery > 0 &&
        t - vehicle.lastForcedAt >= forceEvery &&
        isDaytime(new Date(t)) &&
        // A car being driven sends its state on its own.
        vehicle.snapshot.ignition !== true;
      if (forcedDue) {
        memoryOf(vehicle.info.vin).lastForcedAt = t;
        store.touch();
        await safeRead(vehicle, { forced: true });
      } else if (t - vehicle.lastReadAt >= refresh) {
        await safeRead(vehicle);
      }
    }
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(() => tick().catch((err) => logger.error('Refresh failed', err)), MINUTE);
    ticker.unref?.();
  }

  function stopTicker() {
    clearInterval(ticker);
    ticker = null;
  }

  // --- Commands --------------------------------------------------------------

  /** Keep a background task, so `drain` (tests, shutdown) can wait for it. */
  function track(promise) {
    background.add(promise);
    promise.catch(() => {}).finally(() => background.delete(promise));
    return promise;
  }

  /**
   * Wait for the outcome of a command, then apply what it changed (or put
   * back the real state when it failed).
   * @returns {Promise<string>} one of ACTION_RESULTS
   */
  async function follow(vehicle, msgId, optimistic, label) {
    const sentAt = now();
    let result = ACTION_RESULTS.PENDING;
    while (now() - sentAt < ACTION_TIMEOUT_MS && !stopped) {
      await wait(ACTION_POLL_MS);
      try {
        result = await client.actionResult(vehicle.ref, msgId);
      } catch (err) {
        logger.debug(`Reading the outcome of ${label}: ${err.message}`);
        result = ACTION_RESULTS.UNKNOWN;
      }
      if (result === ACTION_RESULTS.SUCCESS || result === ACTION_RESULTS.FAILED) break;
      if (result === ACTION_RESULTS.TIMEOUT) break;
    }
    if (result === ACTION_RESULTS.SUCCESS) {
      logger.info(`${label}: done`);
      vehicle.override = {
        at: sentAt,
        fields: { ...(vehicle.override?.fields ?? {}), ...optimistic },
      };
      await applyVehicle(vehicle, optimistic);
    } else {
      logger.warn(
        `${label}: ${result === ACTION_RESULTS.FAILED ? 'failed' : 'no confirmation from the car'}`,
      );
      // Gladys shows the value the user asked for: put the known one back.
      await publishVehicle(vehicle, { force: true });
    }
    // The car usually sends its new state after a command.
    track(
      wait(READ_AFTER_COMMAND_MS).then(() =>
        client && !blocked && !stopped ? safeRead(vehicle) : undefined,
      ),
    );
    return result;
  }

  /**
   * Send a command. Resolves once the cloud accepted it, with `outcome`, the
   * promise of its result (followed in the background).
   */
  async function send(vehicle, featureKey, value) {
    if (!client || blocked)
      throw new UserError(STATUS_MESSAGES[blocked] ?? STATUS_MESSAGES.notConfigured);
    const order = vehicleCommand(featureKey, value, vehicle.snapshot, {
      climateDuration: Number(config.climate_duration),
    });
    if (!order) throw new Error(`${featureKey} is read-only`);
    if (order.local) {
      memoryOf(vehicle.info.vin).targetTempC = order.optimistic.targetTempC;
      store.touch();
      await applyVehicle(vehicle, order.optimistic);
      return { outcome: Promise.resolve(ACTION_RESULTS.SUCCESS) };
    }
    const label = `${order.order} → ${vehicle.info.nickname || vehicle.info.vehicleName || 'vehicle'}`;
    logger.info(`Command ${label}`);
    let msgId;
    try {
      msgId = await client[order.order](vehicle.ref, order.args);
    } catch (err) {
      await handleError(err, `Command ${label}`);
      noteCommand(err);
      // Gladys shows the value the user asked for: put the known one back.
      await publishVehicle(vehicle, { force: true });
      throw toUserError(err, pinSaved());
    }
    noteCommand();
    return { outcome: track(follow(vehicle, msgId, order.optimistic, label)) };
  }

  /**
   * Wait for an outcome, at most `limitMs` (the core gives a widget or scene
   * action 120 s at most): past it, PENDING, and the follow-up goes on.
   */
  async function settle(outcome, limitMs = SETTLE_LIMIT_MS) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(ACTION_RESULTS.PENDING), limitMs);
      timer.unref?.();
    });
    return Promise.race([outcome, late]).finally(() => clearTimeout(timer));
  }

  // --- Public API ------------------------------------------------------------

  async function stop() {
    stopped = true;
    stopTicker();
    for (const entry of nudges.values()) clearTimeout(entry.timer);
    nudges.clear();
    client = null;
    await store.flush();
  }

  async function start(newConfig) {
    config = newConfig;
    stopped = false;
    blocked = null;
    commandIssue = null;
    failing.clear();
    statusSent = null;
    backoffUntil = 0;
    lastFailureAt = 0;
    if (!isConfigured(config)) {
      await publishDevices({ force: true });
      await setStatus(false, STATUS_MESSAGES.notConfigured);
      return;
    }
    client = clientFactory(config, store.tokenStore);
    const ok = await connect();
    if (!blocked) startTicker();
    if (ok) logger.info(`Hyundai / Kia: ${vehicles.size} vehicle(s)`);
  }

  const credentialsOf = (c) =>
    JSON.stringify([c?.brand, c?.username, c?.password, c?.pin, c?.account_language]);

  return {
    start,
    stop,
    tick,
    /** Resolves once the command follow-ups in flight are over (tests). */
    async drain() {
      while (background.size) await Promise.allSettled([...background]);
    },

    /** New configuration: sign in again when the account changed, else rebuild. */
    async reconfigure(newConfig) {
      if (!config || credentialsOf(newConfig) !== credentialsOf(config) || blocked) {
        await stop();
        vehicles.clear();
        published.clear();
        publishedDevicesJson = null;
        await start(newConfig);
      } else {
        config = newConfig;
        await publishDevices();
        await publishAll();
      }
      nudgeWidget(WIDGET_KEYS.VEHICLE);
    },

    /** (Re)connected to Gladys: devices and every state again. */
    async resync() {
      published.clear();
      statusSent = null;
      if (statusWanted) await setStatus(...statusWanted);
      await publishDevices({ force: true });
      await publishAll({ force: true });
      nudgeWidget(WIDGET_KEYS.VEHICLE);
    },

    async scan() {
      if (client && !blocked) await discover();
      else await publishDevices({ force: true });
    },

    /** Gladys created a device: its states were dropped until now. */
    async deviceCreated(device) {
      for (const key of [...published.keys()]) {
        if (key.startsWith(`${device.external_id}:`)) published.delete(key);
      }
      const vehicle = findVehicle(device.external_id);
      if (vehicle) await publishVehicle(vehicle, { force: true });
      nudgeWidget(WIDGET_KEYS.VEHICLE);
    },

    /**
     * The core's scheduled poll: a fallback only, no device asks for it (the
     * ticker reads the cloud). Never calls the cloud; publishes what changed.
     */
    async poll(device) {
      const vehicle = findVehicle(device.external_id);
      if (vehicle) await publishVehicle(vehicle);
    },

    /**
     * A user command from Gladys (dashboard, scene). Gladys acks a device
     * command within 5 s: past `deadlineMs`, the command is acknowledged and
     * goes on; its outcome is published (or logged) when it lands.
     */
    async setValue(device, feature, value, { deadlineMs } = {}) {
      const vehicle = findVehicle(device.external_id);
      if (!vehicle) throw new Error(`Unknown device ${device.external_id}`);
      const key = feature.external_id.slice(device.external_id.length + 1);
      const sending = send(vehicle, key, value);
      if (!deadlineMs) return sending.then(() => undefined);
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve('late'), deadlineMs);
      });
      const first = await Promise.race([sending.then(() => 'sent'), late]).finally(() =>
        clearTimeout(timer),
      );
      if (first === 'late') {
        logger.info('The cloud is slow to accept the command (signing in?): still running');
        sending.catch((err) => logger.error(`Command failed: ${err.message}`));
      }
      return undefined;
    },

    /**
     * Command for the widget buttons: waits for the car.
     * @returns {Promise<string>} one of ACTION_RESULTS
     */
    async order(deviceExternalId, featureKey, value) {
      const vehicle = findVehicle(deviceExternalId);
      if (!vehicle) throw new UserError(STATUS_MESSAGES.unknownVehicle);
      const { outcome } = await send(vehicle, featureKey, value);
      return settle(outcome);
    },

    /** Start the climate with explicit settings (scene action). */
    async startClimate(deviceExternalId, { temperature, duration } = {}) {
      const vehicle = findVehicle(deviceExternalId);
      if (!vehicle) throw new UserError(STATUS_MESSAGES.unknownVehicle);
      if (!client || blocked)
        throw new UserError(STATUS_MESSAGES[blocked] ?? STATUS_MESSAGES.notConfigured);
      const celsius = climateTemperature(
        Number.isFinite(Number(temperature)) && temperature !== '' && temperature !== null
          ? temperature
          : (vehicle.snapshot.targetTempC ?? DEFAULT_CLIMATE_TEMP_C),
      );
      const minutes = Math.min(
        30,
        Math.max(1, Math.round(Number(duration) || Number(config.climate_duration))),
      );
      const label = `startClimate → ${vehicle.info.nickname || vehicle.info.vehicleName || 'vehicle'}`;
      logger.info(`Command ${label} (${celsius} °C, ${minutes} min)`);
      let msgId;
      try {
        msgId = await client.startClimate(vehicle.ref, { temperature: celsius, duration: minutes });
      } catch (err) {
        await handleError(err, `Command ${label}`);
        noteCommand(err);
        throw toUserError(err, pinSaved());
      }
      noteCommand();
      const result = await settle(track(follow(vehicle, msgId, { climateOn: true }, label)));
      if (result === ACTION_RESULTS.FAILED) throw new UserError(STATUS_MESSAGES.failed);
      return {
        temperature: celsius,
        duration: minutes,
        confirmed: result === ACTION_RESULTS.SUCCESS,
      };
    },

    /** Wake the car and read its state (scene action, widget button). */
    async forceRefresh(deviceExternalId) {
      const vehicle = findVehicle(deviceExternalId);
      if (!vehicle) throw new UserError(STATUS_MESSAGES.unknownVehicle);
      if (!client || blocked)
        throw new UserError(STATUS_MESSAGES[blocked] ?? STATUS_MESSAGES.notConfigured);
      if (!vehicle.forcing) {
        vehicle.forcing = readVehicle(vehicle, { forced: true }).finally(() => {
          vehicle.forcing = null;
        });
      }
      try {
        await vehicle.forcing;
      } catch (err) {
        await handleError(err, 'Forced refresh');
        throw toUserError(err, pinSaved());
      }
      return vehicle.snapshot;
    },

    /**
     * Connection test (manifest action): resolves a short summary (shown in
     * green), throws an ActionFailure for anything else (shown in red). It
     * tests the configuration the integration runs with: the saved one.
     */
    async testConnection() {
      if (!config) throw new ActionFailure(STATUS_MESSAGES.starting);
      if (!isConfigured(config)) throw new ActionFailure(STATUS_MESSAGES.notSaved);
      let list;
      try {
        const probe = client ?? clientFactory(config, store.tokenStore);
        await probe.connect();
        list = await probe.vehicles();
      } catch (err) {
        logger.warn(`Connection test: ${err.message}`);
        throw new ActionFailure(
          userTextOf(err, pinSaved()) ?? {
            en: `The cloud refused the request: ${String(err.message).slice(0, 120)}`,
            fr: `Le cloud a refusé la requête : ${String(err.message).slice(0, 120)}`,
            de: `Die Cloud hat die Anfrage abgelehnt: ${String(err.message).slice(0, 120)}`,
            es: `La nube ha rechazado la solicitud: ${String(err.message).slice(0, 120)}`,
          },
        );
      }
      const names = list
        .map((v) => String(v.nickname || v.vehicleName || '').trim())
        .filter(Boolean)
        .join(', ');
      // Whatever the protocol: the user cannot tell which one a car speaks,
      // and a saved PIN costs nothing to the cars that do not use it.
      const pinNote =
        list.length > 0 && !config.pin
          ? {
              en: ' Enter the PIN of your account to send remote commands (locks, climate, charging).',
              fr: ' Saisissez le code PIN de votre compte pour les commandes à distance (verrouillage, climatisation, charge).',
              de: ' Gib die PIN deines Kontos ein, um Fernbefehle zu senden (Verriegelung, Klimatisierung, Laden).',
              es: ' Introduzca el PIN de su cuenta para enviar comandos remotos (cierres, climatización, carga).',
            }
          : { en: '', fr: '', de: '', es: '' };
      if (blocked) {
        // The account works again: start over.
        await this.reconfigure(config);
      }
      return {
        en: `Connected: ${list.length} vehicle(s)${names ? ` (${names})` : ''}.${pinNote.en}`,
        fr: `Connecté : ${list.length} véhicule(s)${names ? ` (${names})` : ''}.${pinNote.fr}`,
        de: `Verbunden: ${list.length} Fahrzeug(e)${names ? ` (${names})` : ''}.${pinNote.de}`,
        es: `Conectado: ${list.length} vehículo(s)${names ? ` (${names})` : ''}.${pinNote.es}`,
      };
    },

    // Read access for the widget and the scene actions.
    vehicleView(deviceExternalId) {
      const vehicle = findVehicle(deviceExternalId);
      if (!vehicle) return null;
      const device = vehicleDevice(vehicle);
      return {
        device,
        created: createdDevice(device.external_id) ?? null,
        snapshot: vehicle.snapshot,
        info: vehicle.info,
        // 'pinMissing', ERROR_KINDS.PIN or null
        commandIssue,
      };
    },
    get blocked() {
      return blocked;
    },
    // Exposed for the tests.
    _vehicles: vehicles,
    _published: published,
  };
}

export { VEHICLE_FEATURES };
