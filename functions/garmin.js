// Garmin Connect Personal API helpers.
// Endpoints match Garmin's official client: github.com/garmin/connect-personal-api-python

export const BASE_URL = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const SLEEP_PATH = '/sleep-service/sleep/dailySleep';

export class GarminError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let cached = null; // { key, token, exp }

function jwtExp(token) {
  try {
    const part = token.split('.')[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number(json.exp) || 0;
  } catch { return 0; }
}

/** Exchange the personal API key for a bearer token (valid ~24 h). Cached per instance. */
export async function getToken(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new GarminError('GARMIN_API_KEY is empty. Set it with: firebase functions:secrets:set GARMIN_API_KEY');
  const now = Date.now() / 1000;
  if (cached && cached.key === key && cached.exp - now > 3600) return cached.token;
  const res = await fetch(BASE_URL + TOKEN_PATH, {
    method: 'POST',
    headers: { Accept: '*/*', Authorization: `ApiKey ${key}` },
  });
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).trim().slice(0, 400); } catch {}
    let hint;
    if (res.status === 401 || res.status === 403) {
      hint = 'Garmin rejected the API key. It may have expired or been deleted. Create a new key in Garmin Connect and run: firebase functions:secrets:set GARMIN_API_KEY';
    } else if (res.status >= 500) {
      hint = `Garmin's token service returned an error (HTTP ${res.status}). This usually means the key wasn't recognised (check the whole key was copied, with no quotes, spaces or line breaks) or Garmin's service is having problems. Key length sent: ${key.length} characters.`;
    } else {
      hint = `Garmin token request failed (HTTP ${res.status}).`;
    }
    if (body) hint += `\nGarmin said: ${body}`;
    throw new GarminError(hint, res.status);
  }
  const token = (await res.text()).trim();
  cached = { key, token, exp: jwtExp(token) || now + 20 * 3600 };
  return token;
}

/** Raw daily sleep for a calendar date (YYYY-MM-DD, the morning you woke up). */
export async function fetchDailySleep(token, date) {
  const url = `${BASE_URL}${SLEEP_PATH}?date=${encodeURIComponent(date)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (res.status === 401) { cached = null; throw new GarminError('Garmin bearer token was rejected. The next sync will request a new one.', 401); }
  if (!res.ok) throw new GarminError(`Garmin sleep request failed for ${date} (HTTP ${res.status}).`, res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

/**
 * Turn Garmin's sleep response into the small record the app shows.
 * Garmin does not publish the response schema, so this reads the usual Garmin Connect
 * field names and also keeps the top-level scalar fields under `raw` so nothing is lost.
 */
export function normaliseSleep(date, payload) {
  const raw = payload || {};
  const dto = raw.dailySleepDTO || raw;
  const scores = dto.sleepScores || raw.sleepScores || {};
  const total = num(dto.sleepTimeSeconds);
  const keep = {};
  for (const [k, v] of Object.entries(dto)) {
    if (v === null || typeof v !== 'object') keep[k] = v;
  }
  if (scores && typeof scores === 'object' && scores.overall) keep.sleepScoreOverall = scores.overall;
  return {
    date: (typeof dto.calendarDate === 'string' && dto.calendarDate) || date,
    hasData: total !== null && total > 0,
    totalSec: total,
    deepSec: num(dto.deepSleepSeconds),
    lightSec: num(dto.lightSleepSeconds),
    remSec: num(dto.remSleepSeconds),
    awakeSec: num(dto.awakeSleepSeconds),
    score: num(scores?.overall?.value) ?? num(dto.sleepScore),
    scoreLabel: typeof scores?.overall?.qualifierKey === 'string' ? scores.overall.qualifierKey : null,
    startLocalMs: num(dto.sleepStartTimestampLocal),
    endLocalMs: num(dto.sleepEndTimestampLocal),
    avgSleepHr: num(dto.avgHeartRate),
    avgStress: num(dto.avgSleepStress),
    respiration: num(dto.averageRespirationValue),
    avgSpO2: num(dto.averageSpO2Value),
    raw: keep,
  };
}
