// Reads the data readiness needs from Firestore, computes the score and caches it per date in
// users/{uid}/readiness/{date}. The scoring itself is the pure code in readiness.js.
import { buildInputs, computeReadiness, VERSION } from './readiness.js';

const shift = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function rows(col, from, to) {
  const snap = await col.where('date', '>=', from).where('date', '<=', to).get();
  return snap.docs.map(d => d.data());
}

/**
 * Compute readiness for `date` and store it, once per day.
 * An existing score is only replaced when the new one has fewer missing components
 * (for example when the 10:15 sync picks up sleep the 07:15 sync didn't have), when it was made by an
 * older version of the scoring code, or when `force` is set.
 * @returns {{stored:boolean, result:object}}
 */
export async function computeAndStoreReadiness(db, uid, date, { force = false, now = new Date() } = {}) {
  const user = db.collection('users').doc(uid);
  const from = shift(date, -35);
  const [sleep, metrics, planned] = await Promise.all([
    rows(user.collection('sleep'), from, date),
    rows(user.collection('metrics'), from, date),
    rows(user.collection('workouts'), shift(date, -28), shift(date, -1)),
  ]);
  const result = computeReadiness(buildInputs(date, {
    sleep: sleep.filter(s => s.hasData !== false),
    metrics,
    planned: planned.map(w => ({ date: w.date, dur: Number(w.dur) || 0 })),
  }));

  const ref = user.collection('readiness').doc(date);
  const existing = await ref.get();
  const stale = existing.exists && existing.data().version !== VERSION;
  if (!force && existing.exists && !stale) {
    const old = existing.data();
    const oldMissing = Array.isArray(old.missing) ? old.missing.length : 99;
    if (old.score !== null && result.missing.length >= oldMissing) return { stored: false, result: old };
  }
  if (result.score === null && existing.exists && !force) return { stored: false, result: existing.data() };
  const doc = { ...result, version: VERSION, date, computedAt: now };
  await ref.set(doc);
  return { stored: true, result: doc };
}
