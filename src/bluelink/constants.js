// -----------------------------------------------------------------------------
// Constants of the European Hyundai Bluelink and Kia Connect clouds.
//
// They are those of the official mobile apps, as published by the
// hyundai_kia_connect_api library (MIT, the base of the Home Assistant
// integration kia_uvo), module KiaUvoApiEU.py. They identify the app, not the
// user: they are the same for everyone and are no secret.
//
// Two backends are involved:
//   - the "CCI" login of the OneApp (idpconnect-eu + cci-api-eu): the legacy
//     login of the Bluelink app is blocked by a WAF since 2026 (library issue
//     #1273), the OneApp one is not;
//   - the legacy "CCAPI" (prd.eu-ccapi.*:8080), which still serves the vehicle
//     data and the commands, with a CCS token exchanged from the CCI one.
// -----------------------------------------------------------------------------

export const BRANDS = { HYUNDAI: 'hyundai', KIA: 'kia' };

const COMMON = {
  // Seconds the vehicle data are in: the EU cloud answers local Berlin time.
  dataTimeZone: 'Europe/Berlin',
  cciClientVersion: '1.3.3',
  userAgent: 'okhttp/3.12.0',
  // The login pages answer a mobile browser.
  loginUserAgent:
    'Mozilla/5.0 (Linux; Android 4.1.1; Galaxy Nexus Build/JRO03C) AppleWebKit/535.19 ' +
    '(KHTML, like Gecko) Chrome/18.0.1025.166 Mobile Safari/535.19_CCS_APP_AOS',
};

const BRAND_CONSTANTS = {
  [BRANDS.HYUNDAI]: {
    baseUrl: 'https://prd.eu-ccapi.hyundai.com:8080',
    serviceId: '6d477c38-3ca4-4cf3-9557-2a1929a94654',
    serviceSecret: 'KUy49XxPzLpLuoK0xhBC77W6VXhmtQR9iQhmIFjjoY4IpxsV',
    appId: '014d2225-8495-4735-812d-2616334fd15d',
    cfb: 'RFtoRq/vDXJmRndoZaZQyfOot7OrIqGVFj96iY2WL3yyH5Z/pUvlUhqmCxD2t+D65SQ=',
    pushType: 'GCM',
    loginHost: 'https://idpconnect-eu.hyundai.com',
    oneAppClientId: '4f4953b5-02e1-4dbc-8599-87e983ee1be5',
    oneAppRedirectUri: 'https://oneapp.hyundai.com/redirect',
    cciApiUrl: 'https://cci-api-eu.hyundai.com',
    cciPackageId: 'com.hyundai.oneapp.eu',
    cciClientName: 'hyundai',
    cciClientOsVersion: '18.7',
    cciNotificationProvider: 'APNS',
  },
  [BRANDS.KIA]: {
    baseUrl: 'https://prd.eu-ccapi.kia.com:8080',
    serviceId: 'fdc85c00-0a2f-4c64-bcb4-2cfb1500730a',
    serviceSecret: 'secret',
    appId: 'a2b8469b-30a3-4361-8e13-6fceea8fbe74',
    cfb: 'wLTVxwidmH8CfJYBWSnHD6E0huk0ozdiuygB4hLkM5XCgzAL1Dk5sE36d/bx5PFMbZs=',
    pushType: 'APNS',
    loginHost: 'https://idpconnect-eu.kia.com',
    oneAppClientId: '01b36c86-79e8-486c-8009-15f2ad88d670',
    oneAppRedirectUri: 'https://oneapp.kia.com/redirect',
    cciApiUrl: 'https://cci-api-eu.kia.com',
    cciPackageId: 'com.kia.oneapp.eu',
    cciClientName: 'kia',
    cciClientOsVersion: '27',
    cciNotificationProvider: 'IOS_APPSTORE',
  },
};

/** Every constant of one brand, with the derived URLs. */
export function brandConstants(brand) {
  const constants = BRAND_CONSTANTS[brand];
  if (!constants) throw new Error(`Unknown brand: ${brand}`);
  return {
    ...COMMON,
    ...constants,
    brand,
    userApiUrl: `${constants.baseUrl}/api/v1/user/`,
    spaApiUrl: `${constants.baseUrl}/api/v1/spa/`,
    spaApiUrlV2: `${constants.baseUrl}/api/v2/spa/`,
    cciDomainApiUrl: `${constants.cciApiUrl}/domain/api/`,
  };
}

// Languages the European apps know; the account language is set to one of
// them at login (otherwise the official app switches back to English).
export const ACCOUNT_LANGUAGES = [
  'en',
  'de',
  'fr',
  'it',
  'es',
  'sv',
  'nl',
  'no',
  'cs',
  'sk',
  'hu',
  'da',
  'pl',
  'fi',
  'pt',
];

// Cabin temperatures the EU cars accept, in °C: 14.0 to 31.5 by half degrees.
// The non-CCS2 protocol sends and reads them as a hexadecimal index into this
// list ("0EH" = index 14 = 21 °C).
export const CLIMATE_TEMPERATURES = Array.from({ length: 36 }, (_, i) => (28 + i) * 0.5);

// The cloud answers `vehicleId`-scoped records for a command: its `result`.
export const ACTION_RESULTS = {
  SUCCESS: 'success',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
};
