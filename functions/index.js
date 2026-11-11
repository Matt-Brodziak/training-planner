import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getToken, fetchDailySleep, normaliseSleep, fetchDailyMetrics, GarminError } from './garmin.js';
import { computeAndStoreReadiness } from './readinessStore.js';
import { createMcpHandler } from './mcp.js';

initializeApp();
const db = getFirestore();

// Your Garmin personal API key lives in Google Secret Manager, never in code.
const GARMIN_API_KEY = defineSecret('GARMIN_API_KEY');
// The password Claude's connector must present. Also in Secret Manager, never in code.
const MCP_TOKEN = defineSecret('MCP_TOKEN');
// Your Firebase user ID (shown in the app under Settings). Set in functions/.env
const OWNER_UID = defineString('OWNER_UID');

const TZ = 'Africa/Johannesburg';
const REGION = 'europe-west1';

const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const minusDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

// Readiness needs a 7-day HRV / resting HR baseline and 28 days of load, so metrics always cover 29 days.
const METRIC_DAYS = 29;

async function syncGarmin(days) {
  const uid = OWNER_UID.value();
  if (!uid || uid.startsWith('PASTE')) throw new Error('OWNER_UID is not set in functions/.env');
  const userRef = db.collection('users').doc(uid);
  const metaRef = userRef.collection('meta').doc('garmin');
  const today = localDate();
  let saved = 0, empty = 0;
  try {
    const token = await getToken(GARMIN_API_KEY.value());
    for (let i = 0; i < days; i++) {
      const date = minusDays(today, i);
      const payload = await fetchDailySleep(token, date);
      const rec = normaliseSleep(date, payload);
      if (!rec.hasData) { empty++; continue; }
      await userRef.collection('sleep').doc(date).set({ ...rec, date, syncedAt: FieldValue.serverTimestamp() });
      saved++;
    }

    // HRV, resting HR, stress and training load. A failing endpoint is logged, not fatal.
    const from = minusDays(today, Math.max(days, METRIC_DAYS) - 1);
    const { byDate, errors: metricErrors } = await fetchDailyMetrics(token, from, today);
    const batch = db.batch();
    for (const [date, m] of Object.entries(byDate)) {
      const clean = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
      batch.set(userRef.collection('metrics').doc(date), { ...clean, date, syncedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
    await batch.commit();
    if (metricErrors.length) logger.warn('Garmin metrics partly unavailable', metricErrors);

    const readiness = await computeAndStoreReadiness(db, uid, today);
    await metaRef.set({ lastSync: FieldValue.serverTimestamp(), lastError: null, lastSaved: saved, metricErrors }, { merge: true });
    logger.info(`Garmin sync: ${saved} nights saved, ${empty} without data, ${Object.keys(byDate).length} days of metrics, readiness ${readiness.result.score ?? 'n/a'}${readiness.stored ? '' : ' (kept existing)'}`);
    return { saved, empty, readiness: readiness.result.score ?? null };
  } catch (err) {
    const msg = err instanceof GarminError ? err.message : `Sync failed: ${err.message}`;
    await metaRef.set({ lastAttempt: FieldValue.serverTimestamp(), lastError: msg }, { merge: true });
    logger.error(msg, err);
    throw err;
  }
}

// Runs every morning (and again mid-morning in case your watch synced late).
// Each run syncs sleep and metrics, then computes today's readiness once (see readinessStore.js).
export const garminDailySync = onSchedule(
  { schedule: '15 7,10 * * *', timeZone: TZ, region: REGION, secrets: [GARMIN_API_KEY] },
  async () => { await syncGarmin(3); }
);

// "Sync now" button in the app. Only you can call it.
export const garminSyncNow = onCall(
  { region: REGION, secrets: [GARMIN_API_KEY] },
  async (request) => {
    if (!request.auth || request.auth.uid !== OWNER_UID.value()) {
      throw new HttpsError('permission-denied', 'Only the owner of this planner can sync Garmin data.');
    }
    const days = Math.min(30, Math.max(1, Number(request.data?.days) || 8));
    try {
      return await syncGarmin(days);
    } catch (err) {
      throw new HttpsError('unavailable', err instanceof GarminError ? err.message : 'Garmin sync failed. Check the function logs in the Firebase console.');
    }
  }
);

// Claude connector (MCP). Lets Claude read and write plans, workouts and the library.
// The URL is public because Claude calls it from Anthropic's servers; every request must carry MCP_TOKEN.
export const mcp = onRequest(
  { region: REGION, secrets: [MCP_TOKEN], invoker: 'public', maxInstances: 2, timeoutSeconds: 60 },
  createMcpHandler({ db, getUid: () => OWNER_UID.value(), getToken: () => MCP_TOKEN.value(), tz: TZ, log: logger })
);