// -----------------------------------------------------------------------------
// Device type: WEATHER STATION
// Illustrates read-only sensors (temperature + humidity) refreshed by polling.
// Uses REAL data from the free Open-Meteo API (no hardware, no API key).
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchWeather } from '../weather.js';

const DEVICE_TYPE = 'weather-station';

// Named logger from the SDK: every line is prefixed with [weather-station].
const logger = createLogger({ name: DEVICE_TYPE });

// Unique id provided by the external platform for THIS physical device.
// In a real integration you obtain it when you enumerate devices from the
// platform (cloud API, gateway, serial bus...). It MUST be unique and stable.
// Here we simulate the id Open-Meteo would attach to a station/location.
const PLATFORM_DEVICE_ID = 'openmeteo-48.8566_2.3522';

// Feature keys, kept in one place so discovery and polling always agree.
const FEATURE = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
};

export const weatherStation = {
  key: DEVICE_TYPE,

  deviceExternalId(gladys) {
    return gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID).device;
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
    return {
      name: 'Weather station (Open-Meteo demo)',
      external_id: ids.device,
      // Gladys will call onPoll at this interval (in seconds).
      poll_frequency: config.poll_frequency,
      features: [
        {
          name: 'Temperature',
          external_id: ids.feature(FEATURE.TEMPERATURE),
          category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
          unit:
            config.unit === 'fahrenheit'
              ? DEVICE_FEATURE_UNITS.FAHRENHEIT
              : DEVICE_FEATURE_UNITS.CELSIUS,
          min: -50,
          max: 60,
          read_only: true, // sensor: no action possible
          has_feedback: false,
          keep_history: true, // keep history to draw charts
        },
        {
          name: 'Humidity',
          external_id: ids.feature(FEATURE.HUMIDITY),
          category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
          unit: DEVICE_FEATURE_UNITS.PERCENT,
          min: 0,
          max: 100,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  // Manifest actions owned by this device type (see the `actions` field of
  // `gladys-assistant-integration.json`). Each key is rendered as a button in
  // the Configuration screen; the resolved message (string or multi-language
  // object) is displayed under the button, a thrown error is displayed too.
  actions: {
    async test_weather(gladys, { config }) {
      logger.info('Action test_weather -> live request to the provider');
      const { temperature, humidity } = await fetchWeather(config);
      return {
        en: `Weather provider OK: ${temperature}° / ${humidity}% right now.`,
        fr: `Fournisseur météo OK : ${temperature}° / ${humidity}% actuellement.`,
      };
    },
  },

  async onPoll(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
    logger.info('Polling weather values...');

    // ------------------------------------------------------------------ //
    // DO THE WORK: read the real sensor values.
    // Here it is an HTTP call to Open-Meteo. Replace with your own source.
    // ------------------------------------------------------------------ //
    const { temperature, humidity } = await fetchWeather(config);

    logger.info(`Read: ${temperature}deg / ${humidity}%`);

    // Publish both values in a single request (batch, up to 100).
    await gladys.publishStates([
      { device_feature_external_id: ids.feature(FEATURE.TEMPERATURE), state: temperature },
      { device_feature_external_id: ids.feature(FEATURE.HUMIDITY), state: humidity },
    ]);
  },
};
