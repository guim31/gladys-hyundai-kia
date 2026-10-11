// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Everything Hyundai / Kia lives in
// src/hyundaiKia.js (runtime) and src/bluelink/ (cloud client).
//
// The Gladys supervisor injects GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN
// and GLADYS_INTEGRATION_SELECTOR; `new GladysIntegration()` reads them.
// Every handler is registered BEFORE connect().
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { createStore } from './src/store.js';
import { createHyundaiKia } from './src/hyundaiKia.js';
import { createWidgets } from './src/widgets.js';
import { createSceneActions } from './src/scenes.js';

const gladys = new GladysIntegration();
const store = createStore({ logger });
const runtime = createHyundaiKia({ gladys, store });
let started = false;

gladys.onScanRequest(() => runtime.scan());

// Gladys acks a device command within 5 s: past 4 s (a sign-in first), the
// command is acknowledged and goes on in the background. The car carries it
// out later; its outcome is published when the cloud reports it.
gladys.onSetValue((device, feature, value) =>
  runtime.setValue(device, feature, value, { deadlineMs: 4000 }),
);

// No device is published with `should_poll`: the runtime keeps its own pace.
// Kept as a cheap republication of known values.
gladys.onPoll((device) => runtime.poll(device));

// Gladys drops the states of a feature that does not exist yet: send them
// again now that it does, and let the widget bind to it.
gladys.onDeviceCreated((device) => runtime.deviceCreated(device));
gladys.onDeviceUpdated((device) => runtime.deviceCreated(device));

gladys.onAction('test_connection', () => runtime.testConnection());

for (const [key, handler] of Object.entries(createSceneActions(runtime))) {
  gladys.onSceneAction(key, (fields) => handler({ fields }));
}

for (const [key, widget] of Object.entries(createWidgets(runtime))) {
  gladys.onWidgetGet(key, (request) => widget.get(request));
  if (typeof widget.action === 'function') {
    gladys.onWidgetAction(key, (actionKey, params, { settings }) =>
      widget.action({ actionKey, params, settings }),
    );
  }
}

gladys.onConfigUpdated(async (newConfig) => {
  logger.info('Configuration updated');
  await runtime.reconfigure(normalizeConfig(newConfig));
});

gladys.on('connected', async () => {
  try {
    if (!started) {
      started = true;
      await store.load();
      await runtime.start(normalizeConfig(await gladys.getConfig()));
    } else {
      // Reconnected to Gladys: what was published while disconnected was lost.
      await runtime.resync();
    }
  } catch (err) {
    logger.error('Initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal}, stopping`);
  await runtime.stop();
});

logger.info('Starting the Hyundai / Kia integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
