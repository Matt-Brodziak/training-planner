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

/* ---------- daily metrics for readiness: HRV, resting HR, stress, training load ---------- */
// Field names checked against a real account with test-garmin.mjs (Nov 2026). Dotted names are nested paths.
export const FIELD = {
  date: ['calendarDate', 'date'],
  hrvList: ['hrvSummaries'],
  hrv: ['lastNightAvg'],
  hrvWeekly: ['weeklyAvg'],
  hrvStatus: ['status'],
  summaryList: ['data'],
  rhr: ['heartRate.restingValue'],
  stress: ['stress.avgLevel'],
  activityStart: ['startTimeLocal'],
  activityDuration: ['duration', 'movingDuration', 'elapsedDuration'],
};

const at = (o, path) => path.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);
const pick = (o, names) => { if (!o || typeof o !== 'object') return undefined; for (const n of names) { const v = at(o, n); if (v !== undefined && v !== null) return v; } return undefined; };
const pickNum = (o, names) => { const v = pick(o, names); const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return num(n); };
const pickDate = (o, names) => { const v = pick(o, names); return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null; };
/** The list of records in a response: the body itself if it's an array, else the first array under one of `names`. */
const listOf = (body, names) => { if (Array.isArray(body)) return body; const v = pick(body, names); return Array.isArray(v) ? v : []; };

/** HRV summaries response → [{date, hrv, hrvWeekly, hrvStatus}] */
export function normaliseHrv(body) {
  return listOf(body, FIELD.hrvList).map(r => ({
    date: pickDate(r, FIELD.date),
    hrv: pickNum(r, FIELD.hrv),
    hrvWeekly: pickNum(r, FIELD.hrvWeekly),
    hrvStatus: typeof pick(r, FIELD.hrvStatus) === 'string' ? pick(r, FIELD.hrvStatus) : null,
  })).filter(r => r.date);
}

/** Daily summaries response → [{date, rhr, stress}] */
export function normaliseDailySummaries(body) {
  return listOf(body, FIELD.summaryList).map(r => ({
    date: pickDate(r, FIELD.date),
    rhr: pickNum(r, FIELD.rhr),
    stress: pickNum(r, FIELD.stress),
  })).filter(r => r.date);
}

/**
 * Training load for one activity. Garmin's own training load isn't in the Personal API activity list,
 * so this uses Edwards TRIMP from the heart-rate zone times Garmin does return:
 * minutes in zone 1 × 1 + zone 2 × 2 … + zone 5 × 5.
 * Activities without heart-rate zones count as zone 2 for their whole duration.
 */
export function activityLoad(a) {
  let sec = 0, load = 0;
  for (let z = 1; z <= 5; z++) { const s = num(a?.[`hrTimeInZone_${z}`]); if (s !== null) { sec += s; load += s * z; } }
  if (sec > 0) return load / 60;
  const d = pickNum(a, FIELD.activityDuration);
  return d === null ? null : (d / 60) * 2;
}

/** Activity search response → [{date, load, durationMin}] */
export function normaliseActivities(body) {
  return listOf(body, ['activityList']).map(a => {
    const sec = pickNum(a, FIELD.activityDuration);
    const load = activityLoad(a);
    return { date: pickDate(a, FIELD.activityStart), load: load === null ? null : Math.round(load * 10) / 10, durationMin: sec === null ? null : sec / 60 };
  }).filter(r => r.date);
}

async function getJson(token, path) {
  const res = await fetch(BASE_URL + path, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  if (res.status === 401) { cached = null; throw new GarminError('Garmin bearer token was rejected. The next sync will request a new one.', 401); }
  if (!res.ok) throw new GarminError(`Garmin request failed (HTTP ${res.status}) for ${path.split('?')[0]}`, res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Split [from, to] into ranges of at most `size` days, since Garmin caps some range endpoints. */
function chunks(from, to, size) {
  const out = [];
  for (let s = from; s <= to; s = addDays(s, size)) { const e = addDays(s, size - 1); out.push([s, e < to ? e : to]); }
  return out;
}

/**
 * Daily metrics for every date in [from, to]: { [date]: {hrv, hrvWeekly, hrvStatus, rhr, stress, load, activityMin} }.
 * Each endpoint is optional: one failing is recorded in `errors` and the others still count.
 */
export async function fetchDailyMetrics(token, from, to) {
  const byDate = {};
  const at = d => (byDate[d] = byDate[d] || {});
  const errors = [];
  const tryEach = async (label, fn) => { try { await fn(); } catch (e) { if (e.status === 401) throw e; errors.push(`${label}: ${e.message}`); } };

  await tryEach('HRV', async () => {
    for (const [s, e] of chunks(from, to, 14)) {
      for (const r of normaliseHrv(await getJson(token, `/hrv-service/hrv/daily/${s}/${e}`))) {
        Object.assign(at(r.date), { hrv: r.hrv, hrvWeekly: r.hrvWeekly, hrvStatus: r.hrvStatus });
      }
    }
  });
  await tryEach('Daily summaries', async () => {
    for (const [s, e] of chunks(from, to, 14)) {
      for (const r of normaliseDailySummaries(await getJson(token, `/usersummary-service/v2/dailysummaries?startDate=${s}&endDate=${e}`))) {
        Object.assign(at(r.date), { rhr: r.rhr, stress: r.stress });
      }
    }
  });
  await tryEach('Activities', async () => {
    const seen = new Set();
    for (let start = 0; start < 500; start += 100) {
      const list = normaliseActivities(await getJson(token, `/activitylist-service/activities/search/activities?start=${start}&limit=100&startDate=${from}&endDate=${to}`));
      for (const a of list) {
        if (a.date < from || a.date > to) continue;
        const m = at(a.date);
        if (!seen.has(a.date)) { seen.add(a.date); m.load = null; m.activityMin = 0; }
        if (a.load !== null) m.load = (m.load || 0) + a.load;
        if (a.durationMin !== null) m.activityMin += a.durationMin;
      }
      if (list.length < 100) break;
    }
  });
  return { byDate, errors };
}
