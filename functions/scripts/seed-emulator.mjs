// Fills the LOCAL Firebase emulators with a fake user and ~5 weeks of fake data, so you can try the
// app on localhost without touching your real data. It refuses to run against anything but the emulators.
//
//   1. From the project folder:  firebase emulators:start --only auth,firestore,hosting --project demo-training
//   2. In another terminal:      cd functions && npm run seed:emu
//   3. Open http://localhost:5000/?emu and tap Sign in (signs in as the fake user).
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { computeAndStoreReadiness } from '../readinessStore.js';

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
const PROJECT = 'demo-training'; // "demo-" projects can only ever talk to emulators
const UID = 'dev-user';
const EMAIL = 'dev@example.test', PASSWORD = 'dev-password';

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();

const TZ = 'Africa/Johannesburg';
const today = process.argv[2] || new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const shift = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = iso => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = Monday

// Small deterministic random, so every seed looks the same.
let s = 42;
const rand = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const jitter = (base, spread) => base + (rand() * 2 - 1) * spread;

const WEEK = [
  [],
  [{ disc: 'bike', title: 'Easy spin', dur: 60, dist: 25 }],
  [{ disc: 'run', title: 'Tempo run', dur: 55, dist: 10, notes: '15 min easy warm-up\n3 × 8 min @ tempo (Z3/low Z4), 2 min jog\n10 min easy cool-down' }],
  [{ disc: 'bike', title: 'Easy ride', dur: 75, dist: 30 }],
  [{ disc: 'run', title: 'Easy run', dur: 40, dist: 7 }, { disc: 'strength', title: 'Core and mobility', dur: 30, dist: 0 }],
  [{ disc: 'run', title: 'Long run', dur: 100, dist: 18 }],
  [{ disc: 'bike', title: 'Endurance ride', dur: 150, dist: 60 }],
];

async function wipe(col) {
  const snap = await db.collection('users').doc(UID).collection(col).get();
  const b = db.batch(); snap.docs.forEach(d => b.delete(d.ref)); await b.commit();
}

async function main() {
  try { await auth.createUser({ uid: UID, email: EMAIL, password: PASSWORD, displayName: 'Dev athlete' }); }
  catch (e) { if (e.code !== 'auth/uid-already-exists' && e.code !== 'auth/email-already-exists') throw e; }

  const user = db.collection('users').doc(UID);
  for (const c of ['plans', 'workouts', 'library', 'sleep', 'metrics', 'readiness']) await wipe(c);

  const b = db.batch();
  b.set(user.collection('plans').doc('base'), { name: 'Base', color: '#9A90B3', created: 0 });

  const loads = {};
  for (let i = -35; i <= 20; i++) {
    const date = shift(today, i);
    WEEK[weekday(date)].forEach((w, k) => {
      b.set(user.collection('workouts').doc(`seed-${date}-${k}`), { ...w, notes: w.notes || '', date, plan: 'base', race: false, prio: '', order: k, created: 0 });
      if (i < 0) loads[date] = (loads[date] || 0) + Math.round(w.dur * jitter(1.3, 0.25));
    });
  }
  b.set(user.collection('workouts').doc('seed-race'), { disc: 'run', title: 'Bay to Bay 10K', dur: 48, dist: 10, notes: '', date: shift(today, 24), plan: 'base', race: true, prio: 'A', order: 9, created: 0 });
  WEEK.flat().slice(0, 4).forEach((w, k) => b.set(user.collection('library').doc(`seed-lib-${k}`), { ...w, notes: w.notes || '', race: false, prio: '', created: k }));

  for (let i = -35; i <= 0; i++) {
    const date = shift(today, i);
    const totalSec = Math.round(jitter(7.2, 0.7) * 3600);
    const deep = Math.round(totalSec * jitter(0.18, 0.03)), rem = Math.round(totalSec * jitter(0.22, 0.03));
    const awake = Math.round(jitter(1500, 600));
    const score = i === 0 ? 81 : Math.round(jitter(76, 9));
    const startMs = Date.UTC(2000, 0, 1, 22, Math.round(jitter(20, 20)));
    b.set(user.collection('sleep').doc(date), {
      date, hasData: true, totalSec, deepSec: deep, remSec: rem, lightSec: totalSec - deep - rem, awakeSec: awake,
      score, scoreLabel: score >= 80 ? 'GOOD' : score >= 60 ? 'FAIR' : 'POOR',
      startLocalMs: startMs, endLocalMs: startMs + totalSec * 1000 + awake * 1000,
      avgSleepHr: Math.round(jitter(50, 3)), avgStress: Math.round(jitter(18, 5)), respiration: Math.round(jitter(14, 1)),
    });
    b.set(user.collection('metrics').doc(date), {
      date,
      hrv: i === 0 ? 56 : Math.round(jitter(57, 4)),
      hrvStatus: 'BALANCED',
      rhr: i === 0 ? 51 : Math.round(jitter(48, 1)),
      stress: Math.round(jitter(28, 6)),
      ...(loads[date] ? { load: loads[date] } : {}),
    });
  }
  b.set(user.collection('meta').doc('garmin'), { lastSync: new Date(), lastError: null, lastSaved: 8 });
  await b.commit();

  const { result } = await computeAndStoreReadiness(db, UID, today, { force: true });
  console.log(`Seeded ${PROJECT} for ${today}. Readiness ${result.score} (${result.band}).`);
  console.log(`Open http://localhost:5000/?emu and sign in. Fake account: ${EMAIL} / ${PASSWORD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
