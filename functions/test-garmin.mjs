// Quick local check that your Garmin key works and to see the raw sleep data.
// Usage (from the functions folder):
//   macOS/Linux:  GARMIN_API_KEY="your-key" node test-garmin.mjs 2026-11-05
//   Windows PS:   $env:GARMIN_API_KEY="your-key"; node test-garmin.mjs 2026-11-05
import { getToken, fetchDailySleep, normaliseSleep } from './garmin.js';

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const token = await getToken(process.env.GARMIN_API_KEY);
console.log('Token OK.');
const payload = await fetchDailySleep(token, date);
console.log('\nTop-level fields from Garmin:', Object.keys(payload || {}));
if (payload?.dailySleepDTO) console.log('dailySleepDTO fields:', Object.keys(payload.dailySleepDTO));
const rec = normaliseSleep(date, payload);
delete rec.raw;
console.log('\nWhat the app will show:', rec);
