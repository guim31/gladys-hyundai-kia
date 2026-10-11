// -----------------------------------------------------------------------------
// Sign-in to the European Hyundai Bluelink / Kia Connect accounts.
//
// Ported from hyundai_kia_connect_api (MIT), KiaUvoApiEU.py, as of October
// 2026. Two ways in:
//
//   1. E-mail + password, through the OneApp ("CCI") login, the one the
//      library uses since the legacy login was blocked by a WAF (issue #1273):
//        authorize (cookies) → RSA public key → sign-in with the password
//        RSA-encrypted → authorization code → CCI token set → CCS token
//        (token-exchange), the one the vehicle API accepts.
//      The CCI token set is refreshed without the password
//      (v2/auth/token-refresh), then exchanged again.
//   2. A legacy 48-character refresh token, as produced by the
//      bluelink-refresh-token tools (typed in the password field): exchanged
//      for an access token with the oauth2/token refresh grant.
//
// Every request also needs a "device id", registered once per sign-in as if the
// integration were a phone (notifications/register), and a "Stamp" header
// computed from the app id and the time.
//
// Nothing here logs a token or a password.
// -----------------------------------------------------------------------------

import {
  constants as cryptoConstants,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { BluelinkError, ERROR_KINDS, checkCcapiResponse } from './errors.js';
import { createCookieJar } from './http.js';

// A legacy refresh token: 48 upper-case letters and digits. The CCI refresh
// tokens are longer and only work with the rest of their token set.
export const LEGACY_REFRESH_TOKEN = /^[A-Z0-9]{48}$/;

// Refresh the access token this long before it expires.
export const TOKEN_MARGIN_MS = 10 * 60 * 1000;

/** The `Stamp` header: base64(cfb XOR "<appId>:<unix seconds>"). */
export function computeStamp(constants, nowMs = Date.now()) {
  const raw = Buffer.from(`${constants.appId}:${Math.floor(nowMs / 1000)}`);
  const cfb = Buffer.from(constants.cfb, 'base64');
  const length = Math.min(raw.length, cfb.length);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) out[i] = raw[i] ^ cfb[i];
  return out.toString('base64');
}

/** UTC offset of a time zone now, as "+HH:MM". */
export function timeZoneOffset(timeZone, date = new Date()) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  const match = /GMT([+-]\d{2}:\d{2})/.exec(part ?? '');
  return match ? match[1] : '+00:00';
}

export function createAuth({ constants, http, now = Date.now }) {
  const ccapiHeaders = (extra = {}) => ({
    'ccsp-service-id': constants.serviceId,
    'ccsp-application-id': constants.appId,
    Stamp: computeStamp(constants, now()),
    'User-Agent': constants.userAgent,
    ...extra,
  });

  /** Register this integration as a "phone" of the account: a device id. */
  async function registerDevice() {
    const response = await http.request(`${constants.spaApiUrl}notifications/register`, {
      headers: ccapiHeaders({ 'Content-Type': 'application/json;charset=UTF-8' }),
      json: {
        pushRegId: randomBytes(32).toString('hex'),
        pushType: constants.pushType,
        uuid: randomUUID(),
      },
    });
    const body = checkCcapiResponse(response.json(), response.status);
    const deviceId = body?.resMsg?.deviceId;
    if (!deviceId) throw new BluelinkError(ERROR_KINDS.API, 'No device id in the registration');
    return deviceId;
  }

  /**
   * Set the account language, so the official app does not switch to the
   * language of this sign-in. Best effort: a failure changes nothing else.
   */
  async function setAccountLanguage(language) {
    try {
      const jar = createCookieJar();
      const redirect = `${constants.userApiUrl}oauth2/redirect`;
      await http.request(
        `${constants.userApiUrl}oauth2/authorize?response_type=code&state=test` +
          `&client_id=${constants.serviceId}&redirect_uri=${redirect}&lang=${language}`,
        { jar },
      );
      await http.request(`${constants.userApiUrl}language`, { json: { lang: language }, jar });
      return true;
    } catch {
      return false;
    }
  }

  function cciHeaders({ deviceId, language, tokens, contentType } = {}) {
    const headers = {
      'client-id': constants.cciPackageId,
      'client-name': constants.cciClientName,
      'client-version': constants.cciClientVersion,
      'client-os-code': 'ios',
      'client-os-version': constants.cciClientOsVersion,
      'client-device-id': deviceId ?? '',
      'client-device-model': 'iPhone',
      'client-notification-provider-type': constants.cciNotificationProvider,
      locale: (language ?? 'en').toUpperCase(),
      timezone: timeZoneOffset(constants.dataTimeZone, new Date(now())),
      Accept: 'application/json',
      'Accept-Language': language ?? 'en',
      'User-Agent': constants.userAgent,
    };
    if (tokens) {
      headers.Authentication = tokens.nonCcsToken ?? '';
      headers.authorization = `Bearer ${String(tokens.accessToken ?? '').replace(/^Bearer /, '')}`;
      headers['exchangeable-token'] = tokens.exchangeableToken ?? '';
      headers['non-ccs-token'] = tokens.nonCcsToken ?? '';
    }
    if (contentType) headers['Content-Type'] = contentType;
    return headers;
  }

  /** CCI token set → CCS token for the vehicle API. */
  async function exchangeCcsToken({ deviceId, language, cci }) {
    const response = await http.request(
      `${constants.cciDomainApiUrl}v1/auth/token-exchange?serviceType=CCS`,
      { method: 'POST', headers: cciHeaders({ deviceId, language, tokens: cci }) },
    );
    if (response.status !== 200) {
      throw new BluelinkError(
        response.status === 401 ? ERROR_KINDS.TOKEN_EXPIRED : ERROR_KINDS.API,
        `CCS token exchange refused (HTTP ${response.status})`,
        { status: response.status },
      );
    }
    const data = response.json();
    const token = data?.accessToken ?? data?.ccsAccessToken;
    if (!token) throw new BluelinkError(ERROR_KINDS.API, 'CCS token exchange returned no token');
    // expiresTime is a duration in seconds (86400 = 24 h), not a date.
    const seconds = Number(data.expiresTime);
    return {
      accessToken: `Bearer ${token}`,
      validUntil: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000,
    };
  }

  /** E-mail + password through the OneApp (CCI) login. */
  async function loginWithPassword({ username, password, deviceId, language }) {
    const host = constants.loginHost;
    const clientId = constants.oneAppClientId;
    const redirectUri = constants.oneAppRedirectUri;
    const jar = createCookieJar();
    const headers = { 'User-Agent': constants.loginUserAgent };

    // 1. authorize: sets the session cookies of the sign-in form.
    const authorize = await http.request(
      `${host}/auth/api/v2/user/oauth2/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${redirectUri}&lang=en&state=ccsp&country=de`,
      { headers, jar },
    );
    if (/abusing/i.test(authorize.text) || authorize.url.includes('/error?status=400')) {
      throw new BluelinkError(
        ERROR_KINDS.BLOCKED,
        'The sign-in page refused the request ("abusing request"): a block on the server side, not a credentials problem',
      );
    }

    // 2. the RSA public key the password is encrypted with.
    const certs = await http.request(`${host}/auth/api/v1/accounts/certs`, { headers, jar });
    if (certs.status !== 200) {
      throw new BluelinkError(ERROR_KINDS.API, `Sign-in key unavailable (HTTP ${certs.status})`, {
        status: certs.status,
      });
    }
    const jwk = certs.json()?.retValue ?? {};
    if (!jwk.n || !jwk.e) throw new BluelinkError(ERROR_KINDS.API, 'Sign-in key unreadable');
    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    const encrypted = publicEncrypt(
      { key, padding: cryptoConstants.RSA_PKCS1_PADDING },
      Buffer.from(password, 'utf8'),
    ).toString('hex');

    // 3. sign-in: a 302 to the redirect URI, with the authorization code.
    const signin = await http.request(`${host}/auth/account/signin`, {
      headers,
      jar,
      followRedirects: false,
      form: {
        client_id: clientId,
        encryptedPassword: 'true',
        password: encrypted,
        redirect_uri: redirectUri,
        scope: '',
        nonce: '',
        state: 'ccsp',
        username,
        connector_session_key: '',
        kid: jwk.kid ?? '',
        _csrf: '',
      },
    });
    const location = signin.headers.get('location') ?? '';
    if (signin.status !== 302) {
      throw new BluelinkError(ERROR_KINDS.AUTH, `Sign-in refused (HTTP ${signin.status})`, {
        status: signin.status,
      });
    }
    const query = new URL(location, host).searchParams;
    const code = query.get('code');
    if (!code) {
      if (location.includes('/web/v1/user/authorization')) {
        throw new BluelinkError(
          ERROR_KINDS.CONSENT,
          'The account must accept the terms of use once: sign in to the official app',
        );
      }
      throw new BluelinkError(
        ERROR_KINDS.AUTH,
        query.get('error_description')
          ? `Sign-in refused: ${query.get('error_description')}`
          : 'Sign-in refused: check the e-mail address and the password',
      );
    }

    // 4. authorization code → CCI token set.
    const tokenResponse = await http.request(
      `${constants.cciDomainApiUrl}v1/auth/token?code=${encodeURIComponent(code)}`,
      { method: 'POST', headers: cciHeaders({ deviceId, language }) },
    );
    if (tokenResponse.status !== 200) {
      throw new BluelinkError(
        ERROR_KINDS.API,
        `Token request refused (HTTP ${tokenResponse.status})`,
        { status: tokenResponse.status },
      );
    }
    const set = tokenResponse.json() ?? {};
    const cci = {
      accessToken: set.accessToken ?? '',
      refreshToken: set.refreshToken ?? '',
      exchangeableToken: set.exchangeableAccessToken ?? '',
      exchangeableRefreshToken: set.exchangeableRefreshToken ?? '',
      nonCcsToken: set.nonCcsToken ?? '',
      nonCcsRefreshToken: set.nonCcsRefreshToken ?? '',
      idToken: set.idToken ?? '',
    };

    // 5. CCI → CCS token.
    const ccs = await exchangeCcsToken({ deviceId, language, cci });
    return { kind: 'cci', deviceId, ...ccs, cci };
  }

  /** Legacy refresh token → access token (oauth2/token refresh grant). */
  async function loginWithRefreshToken({ refreshToken, deviceId }) {
    const response = await http.request(`${constants.loginHost}/auth/api/v2/user/oauth2/token`, {
      followRedirects: false,
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: constants.serviceId,
        client_secret: constants.serviceSecret,
      },
    });
    let body;
    try {
      body = response.json();
    } catch (err) {
      if (response.status === 400 || response.status === 401) {
        throw new BluelinkError(ERROR_KINDS.AUTH, 'The refresh token was refused');
      }
      throw err;
    }
    if (!body?.access_token) {
      if (response.status >= 400 && response.status < 500) {
        throw new BluelinkError(ERROR_KINDS.AUTH, 'The refresh token was refused', {
          status: response.status,
        });
      }
      checkCcapiResponse(body, response.status);
      throw new BluelinkError(ERROR_KINDS.API, 'No access token in the answer');
    }
    const seconds = Number(body.expires_in);
    return {
      kind: 'legacy',
      deviceId,
      accessToken: `${body.token_type ?? 'Bearer'} ${body.access_token}`,
      refreshToken: body.refresh_token || refreshToken,
      validUntil: now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 86400) * 1000,
    };
  }

  /** Full sign-in: device id, then password or legacy refresh token. */
  async function login({ username, password, language }) {
    await setAccountLanguage(language);
    const deviceId = await registerDevice();
    if (LEGACY_REFRESH_TOKEN.test(password)) {
      return loginWithRefreshToken({ refreshToken: password, deviceId });
    }
    return loginWithPassword({ username, password, deviceId, language });
  }

  /** A fresh access token from a token set, without the password. */
  async function refresh(tokens, { language } = {}) {
    if (tokens.kind === 'legacy') {
      return loginWithRefreshToken({
        refreshToken: tokens.refreshToken,
        deviceId: tokens.deviceId,
      });
    }
    const response = await http.request(`${constants.cciDomainApiUrl}v2/auth/token-refresh`, {
      headers: cciHeaders({
        deviceId: tokens.deviceId,
        language,
        tokens: tokens.cci,
        contentType: 'application/json',
      }),
      json: {
        accessToken: String(tokens.cci.accessToken ?? '').replace(/^Bearer /, ''),
        refreshToken: tokens.cci.refreshToken ?? '',
        exchangeableAccessToken: tokens.cci.exchangeableToken ?? '',
        exchangeableRefreshToken: tokens.cci.exchangeableRefreshToken ?? '',
        nonCcsToken: tokens.cci.nonCcsToken ?? '',
        nonCcsRefreshToken: tokens.cci.nonCcsRefreshToken ?? '',
        idToken: tokens.cci.idToken ?? '',
      },
    });
    if (response.status !== 200) {
      throw new BluelinkError(
        ERROR_KINDS.TOKEN_EXPIRED,
        `Token refresh refused (HTTP ${response.status})`,
        { status: response.status },
      );
    }
    const data = response.json() ?? {};
    const cci = {
      accessToken: data.accessToken ?? tokens.cci.accessToken,
      refreshToken: data.refreshToken ?? tokens.cci.refreshToken,
      exchangeableToken: data.exchangeableAccessToken ?? tokens.cci.exchangeableToken,
      exchangeableRefreshToken:
        data.exchangeableRefreshToken ?? tokens.cci.exchangeableRefreshToken,
      nonCcsToken: data.nonCcsToken ?? tokens.cci.nonCcsToken,
      nonCcsRefreshToken: data.nonCcsRefreshToken ?? tokens.cci.nonCcsRefreshToken,
      idToken: data.idToken ?? tokens.cci.idToken,
    };
    // The exchangeable token may come back as a cookie ("t=").
    const cookie = /(?:^|[;,\s])t=([^;]+)/.exec(response.headers.get('set-cookie') ?? '');
    if (cookie?.[1]) cci.exchangeableToken = cookie[1];
    const ccs = await exchangeCcsToken({ deviceId: tokens.deviceId, language, cci });
    return { kind: 'cci', deviceId: tokens.deviceId, ...ccs, cci };
  }

  return {
    login,
    refresh,
    registerDevice,
    setAccountLanguage,
    computeStamp: () => computeStamp(constants, now()),
  };
}
