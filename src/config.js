// -----------------------------------------------------------------------------
// Integration configuration: defaults (they MUST match the `default` values of
// the manifest `config_schema`, see test/manifest.test.js) and normalization,
// so the rest of the code never deals with `undefined` or form strings.
// -----------------------------------------------------------------------------

import { ACCOUNT_LANGUAGES, BRANDS } from './bluelink/constants.js';

export const LANGUAGES = ['en', 'fr'];
// Minutes between two reads of the state the car last sent to the cloud.
// Such a read never wakes the car, but counts in the account's daily quota.
export const REFRESH_CHOICES = ['15', '30', '60'];
// Hours between two forced refreshes ('0' = never). A forced refresh wakes the
// car's modem: it drains the 12 V battery and is limited per day.
export const FORCE_REFRESH_CHOICES = ['0', '2', '4', '8', '12'];
// Minutes the climate runs once started.
export const CLIMATE_DURATION_CHOICES = ['5', '10', '15', '20', '30'];
// Forced refreshes are skipped at night (local time of the container, `TZ`).
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 6;

export const DEFAULT_CONFIG = {
  brand: BRANDS.HYUNDAI,
  username: '',
  password: '',
  pin: '',
  account_language: 'fr',
  language: 'en',
  refresh_minutes: '30',
  force_refresh_hours: '0',
  climate_duration: '10',
};

const choice = (value, choices, fallback) =>
  choices.includes(String(value)) ? String(value) : fallback;

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  return {
    brand: choice(config.brand, Object.values(BRANDS), DEFAULT_CONFIG.brand),
    username: String(config.username ?? '').trim(),
    // Never trimmed inside: a password may contain spaces. A pasted refresh
    // token often carries a trailing newline, though.
    password: String(config.password ?? '').replace(/[\r\n]+$/, ''),
    // The PIN is four digits; anything else is ignored.
    pin: /^\d{4}$/.test(String(config.pin ?? '').trim()) ? String(config.pin).trim() : '',
    account_language: choice(
      config.account_language,
      ACCOUNT_LANGUAGES,
      DEFAULT_CONFIG.account_language,
    ),
    language: choice(config.language, LANGUAGES, DEFAULT_CONFIG.language),
    refresh_minutes: choice(
      config.refresh_minutes,
      REFRESH_CHOICES,
      DEFAULT_CONFIG.refresh_minutes,
    ),
    force_refresh_hours: choice(
      config.force_refresh_hours,
      FORCE_REFRESH_CHOICES,
      DEFAULT_CONFIG.force_refresh_hours,
    ),
    climate_duration: choice(
      config.climate_duration,
      CLIMATE_DURATION_CHOICES,
      DEFAULT_CONFIG.climate_duration,
    ),
  };
}

export const isConfigured = (config) => Boolean(config.username && config.password);

/** Period of the cached reads, in milliseconds. */
export const refreshMs = (config) => Number(config.refresh_minutes) * 60 * 1000;

/** Period of the forced refreshes, in milliseconds (0 = never). */
export const forceRefreshMs = (config) => Number(config.force_refresh_hours) * 60 * 60 * 1000;

/** Whether a forced refresh may run at this local hour. */
export function isDaytime(date) {
  const hour = date.getHours();
  return hour >= NIGHT_END_HOUR && hour < NIGHT_START_HOUR;
}
