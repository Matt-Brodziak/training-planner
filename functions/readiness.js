// Daily readiness score (0–100), in the style of Garmin Training Readiness.
// Pure functions only: no Firestore, no network, no clock. Unit tests: readiness.test.js
//
// Each component is normalised to 0–100, then weighted. Missing components are dropped and the
// remaining weights rescaled, so the score never fails because one input is missing.

export const WEIGHTS = { sleep: 0.25, hrv: 0.25, rhr: 0.15, sleepHistory: 0.15, load: 0.20 };
export const ORDER = ['sleep', 'hrv', 'sleepHistory', 'rhr', 'load'];
export const LABELS = { sleep: 'Sleep', hrv: 'HRV status', rhr: 'Resting HR', sleepHistory: 'Sleep history', load: 'Acute load' };

export const BANDS = [
  { min: 95, name: 'Prime', suggestion: 'Fully recovered. A great day for your hardest session.' },
  { min: 75, name: 'High', suggestion: 'Ready to train. Go ahead with today’s plan.' },
  { min: 50, name: 'Moderate', suggestion: 'Good to train as planned. Keep hard efforts controlled.' },
  { min: 25, name: 'Low', suggestion: 'Ease off today. Swap intensity for easy aerobic work.' },
  { min: 0, name: 'Poor', suggestion: 'Prioritise recovery. Rest, or keep it very easy and short.' },
];

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

export function bandFor(score) {
  return BANDS.find(b => score >= b.min) || BANDS[BANDS.length - 1];
}

/** Garmin sleep score is already 0–100. */
export const scoreSleep = s => clamp(s);

/** Last night's HRV ÷ 7-day baseline. At baseline = 75; +10% or more = 100; −20% or less = 0. */
export function scoreHrv(ratio) {
  return clamp(ratio >= 1 ? 75 + (ratio - 1) * 250 : 75 - (1 - ratio) * 375);
}

/** Resting HR minus 7-day baseline, in bpm (higher is worse). At baseline = 75; −10 per bpm above, +5 per bpm below. */
export function scoreRhr(delta) {
  return clamp(delta > 0 ? 75 - 10 * delta : 75 - 5 * delta);
}

/** Average sleep score of the last 3 nights, already 0–100. */
export const scoreSleepHistory = avg => clamp(avg);

/** Acute:chronic ratio (7-day load ÷ weekly average of 28-day load). 0.8–1.3 = 100; 2.0+ = 0; 0 = 60. */
export function scoreLoad(ratio) {
  if (ratio > 1.3) return clamp(100 - ((ratio - 1.3) / 0.7) * 100);
  if (ratio < 0.8) return clamp(60 + (ratio / 0.8) * 40);
  return 100;
}

const hrvLabel = r => r < 0.9 ? 'Low' : r < 0.95 ? 'Slightly low' : r <= 1.1 ? 'Balanced' : 'High';
const loadLabel = r => r < 0.8 ? 'Low' : r <= 1.3 ? 'Optimal' : r <= 1.5 ? 'High' : 'Very high';
const historyLabel = a => a >= 80 ? 'Good' : a >= 60 ? 'Fair' : 'Poor';
const signed = d => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d);

/**
 * @param {object} inp
 * @param {number} [inp.sleepScore]               last night's sleep score
 * @param {{last:number, baseline:number}} [inp.hrv]   ms
 * @param {{last:number, baseline:number}} [inp.rhr]   bpm
 * @param {number[]} [inp.sleepHistory]           sleep scores of the last 3 nights
 * @param {{acute:number, chronic:number, source:'garmin'|'planned'}} [inp.load]  7-day and 28-day totals
 * @returns {{score:number|null, band:string|null, suggestion:string|null, components:object, missing:string[]}}
 */
export function computeReadiness(inp = {}) {
  const c = {};

  if (isNum(inp.sleepScore)) {
    c.sleep = { value: Math.round(inp.sleepScore), score: scoreSleep(inp.sleepScore), label: String(Math.round(inp.sleepScore)) };
  }
  if (inp.hrv && isNum(inp.hrv.last) && isNum(inp.hrv.baseline) && inp.hrv.last > 0 && inp.hrv.baseline > 0) {
    const ratio = inp.hrv.last / inp.hrv.baseline;
    c.hrv = { value: Math.round(inp.hrv.last), baseline: Math.round(inp.hrv.baseline), ratio: +ratio.toFixed(3), score: scoreHrv(ratio), label: hrvLabel(ratio) };
  }
  if (inp.rhr && isNum(inp.rhr.last) && isNum(inp.rhr.baseline) && inp.rhr.last > 0 && inp.rhr.baseline > 0) {
    const delta = Math.round(inp.rhr.last - inp.rhr.baseline);
    c.rhr = { value: Math.round(inp.rhr.last), baseline: Math.round(inp.rhr.baseline), delta, score: scoreRhr(delta), label: `${Math.round(inp.rhr.last)} bpm · ${signed(delta)}` };
  }
  const hist = (inp.sleepHistory || []).filter(isNum);
  if (hist.length) {
    const avg = mean(hist);
    c.sleepHistory = { value: Math.round(avg), nights: hist.length, score: scoreSleepHistory(avg), label: historyLabel(avg) };
  }
  if (inp.load && isNum(inp.load.acute) && isNum(inp.load.chronic) && inp.load.chronic > 0 && inp.load.acute >= 0) {
    const ratio = inp.load.acute / (inp.load.chronic / 4);
    c.load = { value: +ratio.toFixed(2), source: inp.load.source || null, score: scoreLoad(ratio), label: loadLabel(ratio) };
  }

  const present = ORDER.filter(k => c[k]);
  const missing = ORDER.filter(k => !c[k]);
  if (!present.length) return { score: null, band: null, suggestion: null, components: {}, missing };

  const wSum = present.reduce((s, k) => s + WEIGHTS[k], 0);
  let total = 0;
  for (const k of present) {
    c[k].score = Math.round(c[k].score);
    c[k].weight = +(WEIGHTS[k] / wSum).toFixed(4);
    total += c[k].score * WEIGHTS[k] / wSum;
  }
  const score = Math.round(clamp(total));
  const band = bandFor(score);
  return { score, band: band.name, suggestion: band.suggestion, components: c, missing };
}

/* ---------- turning day-by-day records into inputs ---------- */

const shift = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const between = (from, to) => d => d >= from && d <= to;

/**
 * Build computeReadiness() inputs for `date` (YYYY-MM-DD, the morning being scored).
 * @param {string} date
 * @param {object} data
 * @param {{date:string, score?:number}[]} [data.sleep]   one per night, dated the morning you woke up
 * @param {{date:string, hrv?:number, rhr?:number, load?:number}[]} [data.metrics]  Garmin daily metrics
 * @param {{date:string, dur?:number}[]} [data.planned]   planned workouts (dur in minutes): load fallback
 */
export function buildInputs(date, { sleep = [], metrics = [], planned = [] } = {}) {
  const byDate = (list, key) => { const m = new Map(); for (const r of list) if (r && isNum(r[key])) m.set(r.date, r[key]); return m; };
  const sleepScores = byDate(sleep, 'score');
  const hrv = byDate(metrics, 'hrv');
  const rhr = byDate(metrics, 'rhr');

  // Baseline = mean of the 7 days before `date` (not including it). Needs at least 3 values.
  const baseline = m => {
    const v = [];
    for (let i = 1; i <= 7; i++) { const x = m.get(shift(date, -i)); if (isNum(x)) v.push(x); }
    return v.length >= 3 ? mean(v) : undefined;
  };

  const inp = {};
  if (sleepScores.has(date)) inp.sleepScore = sleepScores.get(date);
  if (hrv.has(date)) inp.hrv = { last: hrv.get(date), baseline: baseline(hrv) };
  if (rhr.has(date)) inp.rhr = { last: rhr.get(date), baseline: baseline(rhr) };

  const hist = [0, 1, 2].map(i => sleepScores.get(shift(date, -i))).filter(isNum);
  if (hist.length >= 2) inp.sleepHistory = hist;

  // Load windows end yesterday: today's training hasn't happened yet.
  const in7 = between(shift(date, -7), shift(date, -1));
  const in28 = between(shift(date, -28), shift(date, -1));
  const sum = (list, key, inWin) => list.filter(r => r && inWin(r.date) && isNum(r[key])).reduce((s, r) => s + r[key], 0);
  const garmin28 = sum(metrics, 'load', in28);
  if (garmin28 > 0) {
    inp.load = { acute: sum(metrics, 'load', in7), chronic: garmin28, source: 'garmin' };
  } else {
    const planned28 = sum(planned, 'dur', in28);
    if (planned28 > 0) inp.load = { acute: sum(planned, 'dur', in7), chronic: planned28, source: 'planned' };
  }
  return inp;
}
