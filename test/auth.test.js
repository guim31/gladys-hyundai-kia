import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants as cryptoConstants, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { brandConstants } from '../src/bluelink/constants.js';
import { createHttp } from '../src/bluelink/http.js';
import { computeStamp, createAuth } from '../src/bluelink/auth.js';
import { ERROR_KINDS } from '../src/bluelink/errors.js';
import { createFakeFetch, ok } from './helpers/fakeFetch.js';

const NOW = Date.UTC(2026, 9, 11, 8, 0, 0);
const hyundai = brandConstants('hyundai');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });

// Routes every sign-in goes through first.
const commonRoutes = () => [
  { url: /\/api\/v1\/user\/oauth2\/authorize/, reply: () => ({ text: 'ok' }) },
  { method: 'POST', url: /\/api\/v1\/user\/language$/, reply: () => ({ text: '' }) },
  {
    method: 'POST',
    url: /\/api\/v1\/spa\/notifications\/register$/,
    reply: () => ok({ deviceId: 'device-1' }),
  },
];

function cciRoutes({ signin } = {}) {
  return [
    ...commonRoutes(),
    {
      url: /idpconnect-eu\.hyundai\.com\/auth\/api\/v2\/user\/oauth2\/authorize/,
      reply: () => ({
        text: '<form>sign in</form>',
        headers: { 'set-cookie': 'session=abc; Path=/' },
      }),
    },
    {
      url: /\/auth\/api\/v1\/accounts\/certs$/,
      reply: () => ({ json: { retValue: { kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'key-1' } } }),
    },
    {
      method: 'POST',
      url: /\/auth\/account\/signin$/,
      reply:
        signin ??
        (() => ({
          status: 302,
          headers: { location: 'https://oneapp.hyundai.com/redirect?code=CODE123&state=ccsp' },
        })),
    },
    {
      method: 'POST',
      url: /cci-api-eu\.hyundai\.com\/domain\/api\/v1\/auth\/token\?code=CODE123$/,
      reply: () => ({
        json: {
          accessToken: 'cci-access',
          refreshToken: 'cci-refresh',
          exchangeableAccessToken: 'x-access',
          exchangeableRefreshToken: 'x-refresh',
          nonCcsToken: 'non-ccs',
          nonCcsRefreshToken: 'non-ccs-refresh',
          idToken: 'id',
        },
      }),
    },
    {
      method: 'POST',
      url: /\/domain\/api\/v1\/auth\/token-exchange\?serviceType=CCS$/,
      reply: () => ({ json: { accessToken: 'ccs-token', expiresTime: 86400 } }),
    },
  ];
}

function setup(routes) {
  const fake = createFakeFetch(routes);
  const auth = createAuth({
    constants: hyundai,
    http: createHttp({ fetchImpl: fake.fetchImpl }),
    now: () => NOW,
  });
  return { auth, requests: fake.requests };
}

test('the Stamp header XORs "appId:seconds" with the app key', () => {
  const stamp = Buffer.from(computeStamp(hyundai, NOW), 'base64');
  const cfb = Buffer.from(hyundai.cfb, 'base64');
  const clear = Buffer.from(stamp.map((byte, i) => byte ^ cfb[i])).toString();
  assert.equal(clear, `${hyundai.appId}:${NOW / 1000}`);
});

test('e-mail + password: the five steps of the OneApp sign-in', async () => {
  const { auth, requests } = setup(cciRoutes());
  const tokens = await auth.login({
    username: 'driver@example.com',
    password: 'p@ss word',
    language: 'fr',
  });
  assert.equal(tokens.kind, 'cci');
  assert.equal(tokens.deviceId, 'device-1');
  assert.equal(tokens.accessToken, 'Bearer ccs-token');
  assert.equal(tokens.validUntil, NOW + 86400 * 1000);
  assert.equal(tokens.cci.refreshToken, 'cci-refresh');

  const signin = requests.find((r) => r.url.endsWith('/auth/account/signin'));
  // The session cookie of the form travels with the sign-in.
  assert.match(signin.headers.Cookie, /session=abc/);
  const form = new URLSearchParams(signin.body);
  assert.equal(form.get('username'), 'driver@example.com');
  assert.equal(form.get('encryptedPassword'), 'true');
  assert.equal(form.get('kid'), 'key-1');
  // The password only travels RSA-encrypted.
  assert.ok(!signin.body.includes('p%40ss'));
  const clear = privateDecrypt(
    { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(form.get('password'), 'hex'),
  ).toString();
  assert.equal(clear, 'p@ss word');

  const exchange = requests.find((r) => r.url.includes('token-exchange'));
  assert.equal(exchange.headers.authorization, 'Bearer cci-access');
  assert.equal(exchange.headers['client-device-id'], 'device-1');
});

test('a sign-in sent back to the form is refused credentials', async () => {
  const { auth } = setup(
    cciRoutes({
      signin: () => ({
        status: 302,
        headers: { location: '/auth/api/v2/user/oauth2/authorize?error=access_denied' },
      }),
    }),
  );
  await assert.rejects(auth.login({ username: 'a@b.c', password: 'wrong' }), {
    kind: ERROR_KINDS.AUTH,
  });
});

test('terms to accept and a WAF block are told apart from bad credentials', async () => {
  const consent = setup(
    cciRoutes({
      signin: () => ({
        status: 302,
        headers: { location: 'https://idpconnect-eu.hyundai.com/web/v1/user/authorization' },
      }),
    }),
  );
  await assert.rejects(consent.auth.login({ username: 'a@b.c', password: 'x' }), {
    kind: ERROR_KINDS.CONSENT,
  });

  const routes = cciRoutes();
  routes[3] = {
    url: /idpconnect-eu\.hyundai\.com\/auth\/api\/v2\/user\/oauth2\/authorize/,
    reply: () => ({ text: 'Your request was rejected: abusing request' }),
  };
  const blocked = setup(routes);
  await assert.rejects(blocked.auth.login({ username: 'a@b.c', password: 'x' }), {
    kind: ERROR_KINDS.BLOCKED,
  });
});

test('a legacy refresh token in the password field skips the sign-in form', async () => {
  const token = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4';
  const { auth, requests } = setup([
    ...commonRoutes(),
    {
      method: 'POST',
      url: /idpconnect-eu\.hyundai\.com\/auth\/api\/v2\/user\/oauth2\/token$/,
      reply: () => ({
        json: { access_token: 'legacy-access', token_type: 'Bearer', expires_in: 3600 },
      }),
    },
  ]);
  const tokens = await auth.login({ username: 'a@b.c', password: token, language: 'en' });
  assert.equal(tokens.kind, 'legacy');
  assert.equal(tokens.accessToken, 'Bearer legacy-access');
  assert.equal(tokens.refreshToken, token);
  assert.equal(tokens.validUntil, NOW + 3600 * 1000);
  const grant = new URLSearchParams(requests.at(-1).body);
  assert.equal(grant.get('grant_type'), 'refresh_token');
  assert.equal(grant.get('refresh_token'), token);
  assert.ok(!requests.some((r) => r.url.includes('/auth/account/signin')));
});

test('a refused legacy refresh token is an authentication error', async () => {
  const { auth } = setup([
    ...commonRoutes(),
    {
      method: 'POST',
      url: /oauth2\/token$/,
      reply: () => ({ status: 400, json: { error: 'invalid_grant' } }),
    },
  ]);
  await assert.rejects(
    auth.login({
      username: 'a@b.c',
      password: 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2W3X4',
    }),
    { kind: ERROR_KINDS.AUTH },
  );
});

test('a CCI token set is refreshed without the password, then exchanged again', async () => {
  const { auth, requests } = setup([
    {
      method: 'POST',
      url: /\/domain\/api\/v2\/auth\/token-refresh$/,
      reply: () => ({ json: { accessToken: 'cci-access-2', refreshToken: 'cci-refresh-2' } }),
    },
    {
      method: 'POST',
      url: /token-exchange\?serviceType=CCS$/,
      reply: () => ({ json: { accessToken: 'ccs-2', expiresTime: 600 } }),
    },
  ]);
  const tokens = await auth.refresh({
    kind: 'cci',
    deviceId: 'device-1',
    cci: { accessToken: 'cci-access', refreshToken: 'cci-refresh', nonCcsToken: 'n' },
  });
  assert.equal(tokens.accessToken, 'Bearer ccs-2');
  assert.equal(tokens.cci.refreshToken, 'cci-refresh-2');
  assert.equal(tokens.validUntil, NOW + 600 * 1000);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.refreshToken, 'cci-refresh');
  assert.equal(requests[1].headers.authorization, 'Bearer cci-access-2');
});

test('an unreachable cloud is a network error, not a refused account', async () => {
  const { auth } = setup([]);
  await assert.rejects(auth.login({ username: 'a@b.c', password: 'x' }), {
    kind: ERROR_KINDS.NETWORK,
  });
});
