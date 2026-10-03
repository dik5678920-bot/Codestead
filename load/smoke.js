import http from 'k6/http';
import crypto from 'k6/crypto';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const baseURL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
// Accept an origin only: no embedded credentials, paths, queries or fragments.
const origin = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(baseURL);
if (!origin) throw new Error('BASE_URL must be an HTTP(S) origin.');
const localHosts = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'];
if (!localHosts.includes(origin[2].toLowerCase()) && __ENV.LOAD_OWNER_APPROVED !== 'true') {
  throw new Error('Non-local target refused. Obtain owner OK, then set LOAD_OWNER_APPROVED=true.');
}

const limits = { landing: 1000, login: 3000, lesson: 1500, code_run: 15000 };
const selected = (__ENV.LOAD_SCENARIOS || Object.keys(limits).join(',')).split(',');
if (new Set(selected).size !== selected.length || selected.some((name) => !(name in limits))) {
  throw new Error('LOAD_SCENARIOS must contain unique names: landing,login,lesson,code_run.');
}
const lessonPath = __ENV.LESSON_PATH || '/courses/python/skills/string-transformations';
if (!/^\/courses\/[^/?#]+\/skills\/[^/?#]+$/.test(lessonPath)) {
  throw new Error('LESSON_PATH must be /courses/<courseId>/skills/<skillId>.');
}
const lessonText = __ENV.LESSON_TEXT;
if (selected.includes('lesson') && !lessonText) throw new Error('Set LESSON_TEXT to a phrase from the selected lesson.');
const accounts = selected.some((name) => name !== 'landing')
  ? JSON.parse(open(__ENV.LOAD_ACCOUNTS_FILE || './accounts.local.json')) : {};
for (const name of selected.filter((name) => name !== 'landing')) {
  const account = accounts[name];
  if (!account?.email || !account.password || !/^[A-Z2-7]+=*$/i.test(account.totpSecret || '')) {
    throw new Error(`Provide email, password and a base32 totpSecret for ${name}.`);
  }
}
const emails = selected.filter((name) => name !== 'landing').map((name) => accounts[name].email.toLowerCase());
if (new Set(emails).size !== emails.length) throw new Error('Use a different account for each authenticated scenario.');

const latency = new Trend('flow_latency', true);
const errors = new Rate('flow_errors');
const samples = new Counter('flow_samples');
const scenarios = {};
const thresholds = {};
for (const name of selected) {
  scenarios[name] = {
    executor: 'constant-vus', exec: name, vus: 1,
    duration: __ENV.LOAD_DURATION || '1m', gracefulStop: '45s',
  };
  thresholds[`flow_latency{flow:${name}}`] = [`p(95)<${limits[name]}`];
  thresholds[`flow_errors{flow:${name}}`] = ['rate<0.01'];
  thresholds[`flow_samples{flow:${name}}`] = ['count>0'];
  thresholds[`http_req_failed{scenario:${name}}`] = ['rate<0.01'];
}

export const options = {
  scenarios, thresholds, noCookiesReset: true,
  // Do not emit account-bearing auth bodies/URLs as metric tags.
  systemTags: ['scenario', 'name', 'method', 'status', 'expected_response'],
  setupTimeout: '2m', teardownTimeout: '1m',
};

function params(name) {
  return {
    redirects: 0, timeout: '30s', tags: { name },
    headers: { Origin: baseURL, 'Content-Type': 'application/json', 'User-Agent': 'Codestead local k6 smoke' },
    responseCallback: http.expectedStatuses(200),
  };
}

function json(response) {
  try { return response.json(); } catch { return null; }
}

// RFC 6238: base32 secret, SHA-1, 30-second step, six digits.
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase().replace(/=+$/, '')) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = new ArrayBuffer(8);
  const view = new DataView(counter);
  const step = Math.floor(Date.now() / 30000);
  view.setUint32(0, Math.floor(step / 4294967296));
  view.setUint32(4, step >>> 0);
  const digest = new Uint8Array(crypto.hmac('sha1', key.buffer, counter, 'binary'));
  const offset = digest[digest.length - 1] & 15;
  const value = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 1000000).padStart(6, '0');
}

function signIn(account) {
  const response = http.post(`${baseURL}/api/auth/sign-in/email`, JSON.stringify({
    email: account.email, password: account.password, rememberMe: false,
  }), params('sign-in'));
  const body = json(response);
  if (response.status !== 200 || !body) return false;
  if (body.twoFactorRedirect === true) {
    const verified = http.post(`${baseURL}/api/auth/two-factor/verify-totp`, JSON.stringify({
      code: totp(account.totpSecret), trustDevice: false,
    }), params('verify-totp'));
    if (verified.status !== 200) return false;
  }
  // Protected route verifies active account + completed MFA, not just a cookie.
  return http.get(`${baseURL}/learn`, params('authenticated-readiness')).status === 200;
}

function signOut() {
  return http.post(`${baseURL}/api/auth/sign-out`, '{}', params('sign-out')).status === 200;
}

function installCookies(cookies) {
  const jar = http.cookieJar();
  jar.clear(baseURL);
  for (const [name, values] of Object.entries(cookies)) {
    for (const value of values) jar.set(baseURL, name, value, { path: '/' });
  }
}

export function setup() {
  const sessions = {};
  for (const name of selected.filter((name) => name === 'lesson' || name === 'code_run')) {
    http.cookieJar().clear(baseURL);
    if (!signIn(accounts[name])) {
      signOut();
      for (const cookies of Object.values(sessions)) { installCookies(cookies); signOut(); }
      fail(`Cannot authenticate ${name}. Check account setup, MFA, active sessions and rate limits.`);
    }
    sessions[name] = http.cookieJar().cookiesForURL(baseURL);
  }
  return sessions;
}

function record(flow, started, ok) {
  const tags = { flow };
  latency.add(Date.now() - started, tags);
  errors.add(!ok, tags);
  samples.add(1, tags);
  check(ok, { [`${flow} returns expected content`]: (value) => value }, tags);
}

export function landing() {
  http.cookieJar().clear(baseURL);
  const started = Date.now();
  const response = http.get(`${baseURL}/`, params('landing'));
  record('landing', started, response.status === 200 && (response.body || '').includes('Codestead'));
  sleep(1);
}

export function login() {
  http.cookieJar().clear(baseURL);
  const started = Date.now();
  const ok = signIn(accounts.login);
  record('login', started, ok);
  check(signOut(), { 'login session is signed out': (value) => value });
  // Never reuse the same TOTP step; respect 8 sign-ins/minute and 6 MFA/minute.
  sleep(31);
}

export function lesson(sessions) {
  installCookies(sessions.lesson);
  const started = Date.now();
  const response = http.get(`${baseURL}${lessonPath}`, params('lesson'));
  record('lesson', started, response.status === 200 && (response.body || '').includes(lessonText));
  sleep(1);
}

function uuid() {
  const bytes = new Uint8Array(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function code_run(sessions) {
  installCookies(sessions.code_run);
  const requestId = uuid();
  const started = Date.now();
  const response = http.post(`${baseURL}/api/code/run`, JSON.stringify({
    language: 'javascript', source: 'console.log("codestead-k6");',
    mode: 'quick_run', clientRequestId: requestId,
  }), params('code-run'));
  const body = json(response);
  record('code_run', started, response.status === 200 && body?.requestId === requestId
    && body.status === 'accepted' && body.exitCode === 0
    && body.stdout?.trim() === 'codestead-k6' && body.officialMasteryEvidence === false);
  // One account: at most ~9/minute. Longer runs can still hit 120/hour.
  sleep(7);
}

export function teardown(sessions) {
  for (const cookies of Object.values(sessions)) {
    installCookies(cookies);
    check(signOut(), { 'fixture session is signed out': (value) => value });
  }
}
