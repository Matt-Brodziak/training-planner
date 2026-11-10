import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getToken, fetchDailySleep, normaliseSleep, GarminError } from './garmin.js';

initializeApp();
const db = getFirestore();

// Your Garmin personal API key lives in Google Secret Manager, never in code.
const GARMIN_API_KEY = defineSecret('GARMIN_API_KEY');
// Your Firebase user ID (shown in the app under Settings). Set in functions/.env
const OWNER_UID = defineString('OWNER_UID');

const TZ = 'Africa/Johannesburg';
const REGION = 'europe-west1';

const localDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const minusDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

async function syncSleep(days) {
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
    await metaRef.set({ lastSync: FieldValue.serverTimestamp(), lastError: null, lastSaved: saved }, { merge: true });
    logger.info(`Garmin sleep sync: ${saved} nights saved, ${empty} without data`);
    return { saved, empty };
  } catch (err) {
    const msg = err instanceof GarminError ? err.message : `Sync failed: ${err.message}`;
    await metaRef.set({ lastAttempt: FieldValue.serverTimestamp(), lastError: msg }, { merge: true });
    logger.error(msg, err);
    throw err;
  }
}

// Runs every morning (and again mid-morning in case your watch synced late).
export const garminDailySync = onSchedule(
  { schedule: '15 7,10 * * *', timeZone: TZ, region: REGION, secrets: [GARMIN_API_KEY] },
  async () => { await syncSleep(3); }
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
      return await syncSleep(days);
    } catch (err) {
      throw new HttpsError('unavailable', err instanceof GarminError ? err.message : 'Garmin sync failed. Check the function logs in the Firebase console.');
    }
  }
);
