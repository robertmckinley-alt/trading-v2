import { createHmac, timingSafeEqual } from 'node:crypto';

export const OPERATOR_COOKIE = 'doctortrades_operator';
const SESSION_CONTEXT = 'doctortrades-operator-session-v1';

function configuredToken() {
  const token = String(process.env.TRADING_ADMIN_TOKEN || '');
  return token.length >= 20 ? token : '';
}

export function isOperatorAuthConfigured() {
  return Boolean(configuredToken());
}

export function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function operatorSessionValue(token = configuredToken()) {
  if (!token) return '';
  return createHmac('sha256', token).update(SESSION_CONTEXT).digest('base64url');
}

export function verifyOperatorPasscode(passcode) {
  const token = configuredToken();
  return Boolean(token) && timingSafeMatch(passcode, token);
}

export function isOperatorRequest(request) {
  const token = configuredToken();
  if (!token) return false;

  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (bearer && timingSafeMatch(bearer, token)) return true;

  const cookie = request.cookies?.get(OPERATOR_COOKIE)?.value || '';
  return timingSafeMatch(cookie, operatorSessionValue(token));
}

export function isTrustedMutationOrigin(request) {
  if ((request.headers.get('authorization') || '').startsWith('Bearer ')) return true;
  const origin = request.headers.get('origin');
  if (!origin) return process.env.NODE_ENV !== 'production';
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const forwardedProtocol = request.headers.get('x-forwarded-proto') || requestUrl.protocol.replace(':', '');
  const allowedOrigins = new Set([
    requestUrl.origin,
    forwardedHost ? `${forwardedProtocol}://${forwardedHost}` : null
  ].filter(Boolean));
  return allowedOrigins.has(origin);
}

export function operatorCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 12 * 60 * 60
  };
}
