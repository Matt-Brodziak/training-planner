// Quick local check that your Garmin key works, and a map of the data each endpoint returns.
// Usage (from the functions folder):
//   macOS/Linux:  GARMIN_API_KEY="your-key" node test-garmin.mjs 2026-11-05
//   Windows PS:   $env:GARMIN_API_KEY="your-key"; node test-garmin.mjs 2026-11-05
//
// For each endpoint it prints the field names, their types and one sample value, so we can map
// HRV, resting HR, stress and training load. It never prints your key or token.
import { BASE_URL, getToken, fetchDailySleep, normaliseSleep } from './garmin.js';

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const minus = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const d7 = minus(date, 7), d28 = minus(date, 28);

const token = await getToken(process.env.GARMIN_API_KEY);
console.log('Token OK.');

// Print the shape of a JSON value: keys, types and a short sample, a few levels deep.
// Arrays show their length and the shape of the first element only.
function shape(v, indent = '  ', depth = 0) {
  const pad = indent.repeat(depth + 1);
  if (Array.isArray(v)) {
    console.log(`${pad}[array, ${v.length} items]${v.length ? ' first item:' : ''}`);
    if (v.length && depth < 4) shape(v[0], indent, depth + 1);
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (x && typeof x === 'object') {
        console.log(`${pad}${k}: ${Array.isArray(x) ? `array(${x.length})` : 'object'}`);
        if (depth < 4) shape(x, indent, depth + 1);
      } else {
        const s = typeof x === 'string' ? JSON.stringify(x.length > 40 ? x.slice(0, 40) + '…' : x) : String(x);
        console.log(`${pad}${k}: ${x === null ? 'null' : typeof x} = ${s}`);
      }
    }
    return;
  }
  console.log(`${pad}${typeof v} = ${String(v)}`);
}

async function get(path) {
  const res = await fetch(BASE_URL + path, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.trim().slice(0, 300) };
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const endpoints = [
  ['HRV summaries (last 7 days)', `/hrv-service/hrv/daily/${d7}/${date}`],
  ['HRV for the day', `/hrv-service/hrv/${date}`],
  ['Daily summaries (resting HR, stress?)', `/usersummary-service/v2/dailysummaries?startDate=${d7}&endDate=${date}`],
  ['Daily heart rate', `/wellness-service/wellness/dailyHeartRate?date=${date}`],
  ['Daily stress (last 7 days)', `/usersummary-service/stats/stress/daily/${d7}/${date}`],
  ['Body Battery (last 7 days)', `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${d7}&endDate=${date}`],
  ['Sleep summaries (last 7 days)', `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${d7}&endDate=${date}`],
  ['Activities (last 28 days, training load?)', `/activitylist-service/activities/search/activities?start=0&limit=50&startDate=${d28}&endDate=${date}`],
];

// Sleep first: the full payload, not only dailySleepDTO, since HRV and resting HR may be in it.
const sleep = await fetchDailySleep(token, date);
console.log(`\n=== Daily sleep ${date} (full payload) ===`);
shape(sleep);

for (const [label, path] of endpoints) {
  console.log(`\n=== ${label} ===\nGET ${path.split('?')[0]}`);
  try {
    const r = await get(path);
    if (r.error !== undefined) { console.log(`  HTTP ${r.status}: ${r.error}`); continue; }
    shape(r.body);
  } catch (e) {
    console.log(`  Failed: ${e.message}`);
  }
}

const rec = normaliseSleep(date, sleep);
delete rec.raw;
console.log('\n=== What the app currently stores for sleep ===\n', rec);
