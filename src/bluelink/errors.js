// -----------------------------------------------------------------------------
// Errors of the Bluelink / Kia Connect clouds, sorted by what the runtime does
// about them (see src/hyundaiKia.js).
//
// The CCAPI answers HTTP 200 with `{ retCode: "F", resCode, resMsg }` for most
// failures: the `resCode` decides. Known codes, from hyundai_kia_connect_api
// (ApiImplType1._check_response_for_errors).
// -----------------------------------------------------------------------------

export const ERROR_KINDS = {
  // The account refused the credentials (or the refresh token): stop, the
  // user must fix the configuration. Insisting could lock the account.
  AUTH: 'auth',
  // The account must accept new terms once in the official app or a browser.
  CONSENT: 'consent',
  // The login pages answered "abusing request": a server-side block.
  BLOCKED: 'blocked',
  // The PIN was refused (commands of the CCS2 cars).
  PIN: 'pin',
  // The access token expired: refresh it and try again once.
  TOKEN_EXPIRED: 'token-expired',
  // The device id was dropped by the cloud (4002): register a new one.
  DEVICE_ID: 'device-id',
  // "Exceeds number of requests" (5091): the daily quota is spent.
  RATE_LIMIT: 'rate-limit',
  // The car did not answer in time (4081, 9999) or is unreachable (5031).
  CAR_UNAVAILABLE: 'car-unavailable',
  // The car refuses this control (4005), e.g. a feature it does not have.
  UNSUPPORTED: 'unsupported',
  // Another command is already running (4004).
  DUPLICATE: 'duplicate',
  NETWORK: 'network',
  SERVER: 'server',
  API: 'api',
};

export class BluelinkError extends Error {
  constructor(kind, message, { code, status } = {}) {
    super(message);
    this.name = 'BluelinkError';
    this.kind = kind;
    if (code !== undefined) this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const RES_CODES = {
  7501: ERROR_KINDS.TOKEN_EXPIRED,
  4002: ERROR_KINDS.DEVICE_ID,
  4004: ERROR_KINDS.DUPLICATE,
  4005: ERROR_KINDS.UNSUPPORTED,
  4081: ERROR_KINDS.CAR_UNAVAILABLE,
  5031: ERROR_KINDS.CAR_UNAVAILABLE,
  5091: ERROR_KINDS.RATE_LIMIT,
  9999: ERROR_KINDS.CAR_UNAVAILABLE,
};

const EXPIRED_MESSAGES = [
  'Key not authorized: Token is expired',
  'Key not authorized: token has expired',
];

/**
 * Throw the error a CCAPI answer carries, if any.
 * @param {object} body parsed JSON answer
 * @param {number} status HTTP status
 */
export function checkCcapiResponse(body, status) {
  if (!body || typeof body !== 'object') {
    throw new BluelinkError(
      status >= 500 ? ERROR_KINDS.SERVER : ERROR_KINDS.API,
      `Unexpected answer (HTTP ${status})`,
      { status },
    );
  }
  if (body.retCode === 'F') {
    const code = String(body.resCode ?? '');
    const kind = RES_CODES[code] ?? ERROR_KINDS.API;
    throw new BluelinkError(kind, `Bluelink error ${code}: ${describe(body.resMsg)}`, {
      code,
      status,
    });
  }
  if (typeof body.error === 'string' || typeof body.error?.message === 'string') {
    const message = typeof body.error === 'string' ? body.error : body.error.message;
    const kind =
      EXPIRED_MESSAGES.includes(message) || status === 401
        ? ERROR_KINDS.TOKEN_EXPIRED
        : ERROR_KINDS.API;
    throw new BluelinkError(kind, message, { status });
  }
  if (status === 401) throw new BluelinkError(ERROR_KINDS.TOKEN_EXPIRED, 'HTTP 401', { status });
  if (status >= 500) throw new BluelinkError(ERROR_KINDS.SERVER, `HTTP ${status}`, { status });
  if (status >= 400) throw new BluelinkError(ERROR_KINDS.API, `HTTP ${status}`, { status });
  return body;
}

function describe(resMsg) {
  if (typeof resMsg === 'string') return resMsg;
  if (resMsg === undefined || resMsg === null) return 'no message';
  return JSON.stringify(resMsg).slice(0, 200);
}
