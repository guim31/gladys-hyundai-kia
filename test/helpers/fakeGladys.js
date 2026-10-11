// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the surface the integration relies on and records every call:
//   - externalIds(type, platformId) -> { device, feature(key) } (same shape as
//     the SDK, with the `ext:<selector>:` prefix)
//   - devices                        -> the devices "created by the user"
//   - publishDiscoveredDevices, publishStates, setConnectionStatus,
//     publishSceneEvent, requestWidgetRefresh -> recorded
// -----------------------------------------------------------------------------

export function createFakeGladys({ selector = 'hyundai-kia' } = {}) {
  const fake = {
    discovered: [],
    published: [],
    connectionStatuses: [],
    sceneEvents: [],
    widgetRefreshes: [],
    publishCalls: 0,
    devices: [],

    externalIds(type, platformId) {
      const device = `ext:${selector}:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },

    async publishDiscoveredDevices(devices) {
      fake.discovered = structuredClone(devices);
    },

    async publishStates(states) {
      if (states.length > 100) throw new Error('max 100 states per request');
      fake.publishCalls += 1;
      for (const s of states) {
        fake.published.push({
          featureExternalId: s.device_feature_external_id,
          state: s.state ?? { text: s.text },
        });
      }
    },

    async setConnectionStatus(connected, message) {
      fake.connectionStatuses.push({ connected, message });
    },

    async publishSceneEvent(key, data = {}) {
      fake.sceneEvents.push({ key, data });
      return { success: true };
    },

    requestWidgetRefresh(key) {
      fake.widgetRefreshes.push(key);
    },

    /** Simulate the user clicking "Add" on every discovered device. */
    createAll() {
      fake.devices = structuredClone(fake.discovered);
      return fake.devices;
    },

    /** Last published value of a feature. */
    last(featureExternalId) {
      for (let i = fake.published.length - 1; i >= 0; i -= 1) {
        if (fake.published[i].featureExternalId === featureExternalId) {
          return fake.published[i].state;
        }
      }
      return undefined;
    },
  };
  return fake;
}
