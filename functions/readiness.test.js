// Run: cd functions && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeReadiness, buildInputs, bandFor, WEIGHTS,
  scoreSleep, scoreHrv, scoreRhr, scoreSleepHistory, scoreLoad,
} from './readiness.js';

const full = {
  sleepScore: 81,
  hrv: { last: 55, baseline: 55 },
  rhr: { last: 51, baseline: 48 },
  sleepHistory: [81, 74, 70],
  load: { acute: 400, chronic: 1600, source: 'garmin' },
};

test('component normalisers', () => {
  assert.equal(scoreSleep(81), 81);
  assert.equal(scoreSleep(130), 100);
  assert.equal(scoreSleep(-5), 0);

  assert.equal(scoreHrv(1), 75);
  assert.equal(scoreHrv(1.1), 100);
  assert.equal(scoreHrv(1.5), 100);
  assert.ok(Math.abs(scoreHrv(0.8)) < 1e-9);
  assert.ok(Math.abs(scoreHrv(0.9) - 37.5) < 1e-9);

  assert.equal(scoreRhr(0), 75);
  assert.equal(scoreRhr(3), 45);
  assert.equal(scoreRhr(10), 0);
  assert.equal(scoreRhr(-2), 85);
  assert.equal(scoreRhr(-10), 100);

  assert.equal(scoreSleepHistory(75), 75);

  assert.equal(scoreLoad(0.8), 100);
  assert.equal(scoreLoad(1.0), 100);
  assert.equal(scoreLoad(1.3), 100);
  assert.equal(scoreLoad(2.0), 0);
  assert.equal(scoreLoad(3), 0);
  assert.equal(scoreLoad(0), 60);
  assert.equal(scoreLoad(0.4), 80);
  assert.ok(Math.abs(scoreLoad(1.65) - 50) < 1e-9);
});

test('weights sum to 1', () => {
  assert.ok(Math.abs(Object.values(WEIGHTS).reduce((s, w) => s + w, 0) - 1) < 1e-9);
});

test('bands at their boundaries', () => {
  const cases = [[0, 'Poor'], [24, 'Poor'], [25, 'Low'], [49, 'Low'], [50, 'Moderate'], [74, 'Moderate'], [75, 'High'], [94, 'High'], [95, 'Prime'], [100, 'Prime']];
  for (const [s, name] of cases) assert.equal(bandFor(s).name, name, `score ${s}`);
});

test('full inputs: weighted score, labels and band', () => {
  const r = computeReadiness(full);
  // 81*.25 + 75*.25 + 45*.15 + 75*.15 + 100*.20 = 20.25 + 18.75 + 6.75 + 11.25 + 20 = 77
  assert.equal(r.score, 77);
  assert.equal(r.band, 'High');
  assert.ok(r.suggestion.length > 0);
  assert.deepEqual(r.missing, []);
  assert.equal(r.components.sleep.label, '81');
  assert.equal(r.components.hrv.label, 'Balanced');
  assert.equal(r.components.rhr.label, '+3 bpm');
  assert.equal(r.components.sleepHistory.label, 'Fair');
  assert.equal(r.components.load.label, 'Optimal');
  assert.equal(r.components.load.value, 1);
  assert.equal(r.components.load.source, 'garmin');
});

test('missing components are re-weighted, not failed', () => {
  const r = computeReadiness({ sleepScore: 80, load: { acute: 400, chronic: 1600 } });
  // (80*.25 + 100*.20) / .45 = 88.9
  assert.equal(r.score, 89);
  assert.deepEqual(r.missing, ['hrv', 'sleepHistory', 'rhr']);
  assert.ok(Math.abs(r.components.sleep.weight + r.components.load.weight - 1) < 1e-3);
});

test('only one component still gives a score', () => {
  const r = computeReadiness({ sleepScore: 20 });
  assert.equal(r.score, 20);
  assert.equal(r.band, 'Poor');
});

test('no usable inputs returns null score', () => {
  for (const inp of [undefined, {}, { hrv: { last: 50 } }, { rhr: { last: 50, baseline: 0 } }, { load: { acute: 5, chronic: 0 } }, { sleepScore: NaN }]) {
    const r = computeReadiness(inp);
    assert.equal(r.score, null);
    assert.equal(r.band, null);
    assert.equal(r.missing.length, 5);
  }
});

test('labels for HRV, resting HR and load extremes', () => {
  assert.equal(computeReadiness({ hrv: { last: 40, baseline: 50 } }).components.hrv.label, 'Low');
  assert.equal(computeReadiness({ hrv: { last: 60, baseline: 50 } }).components.hrv.label, 'High');
  assert.equal(computeReadiness({ rhr: { last: 46, baseline: 48 } }).components.rhr.label, '−2 bpm');
  assert.equal(computeReadiness({ rhr: { last: 48, baseline: 48 } }).components.rhr.label, '±0 bpm');
  assert.equal(computeReadiness({ load: { acute: 800, chronic: 1600 } }).components.load.label, 'Very high');
  assert.equal(computeReadiness({ load: { acute: 100, chronic: 1600 } }).components.load.label, 'Low');
  assert.equal(computeReadiness({ sleepHistory: [85, 90] }).components.sleepHistory.label, 'Good');
});

test('score is always an integer between 0 and 100', () => {
  const worst = computeReadiness({ sleepScore: 0, hrv: { last: 10, baseline: 60 }, rhr: { last: 70, baseline: 45 }, sleepHistory: [0, 0, 0], load: { acute: 5000, chronic: 2000 } });
  assert.equal(worst.score, 0);
  const best = computeReadiness({ sleepScore: 100, hrv: { last: 70, baseline: 60 }, rhr: { last: 40, baseline: 50 }, sleepHistory: [100, 100, 100], load: { acute: 400, chronic: 1600 } });
  assert.equal(best.score, 100);
  assert.equal(best.band, 'Prime');
});

/* ---------- buildInputs ---------- */

const D = '2026-11-11';
const day = n => { const d = new Date(D + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('buildInputs: baselines exclude today and use the previous 7 days', () => {
  const metrics = [{ date: D, hrv: 50, rhr: 51 }];
  for (let i = 1; i <= 7; i++) metrics.push({ date: day(-i), hrv: 60, rhr: 48 });
  metrics.push({ date: day(-8), hrv: 999, rhr: 999 }); // outside the window
  const inp = buildInputs(D, { metrics });
  assert.deepEqual(inp.hrv, { last: 50, baseline: 60 });
  assert.deepEqual(inp.rhr, { last: 51, baseline: 48 });
});

test('buildInputs: baseline needs at least 3 days', () => {
  const inp = buildInputs(D, { metrics: [{ date: D, hrv: 50 }, { date: day(-1), hrv: 60 }, { date: day(-2), hrv: 60 }] });
  assert.equal(inp.hrv.baseline, undefined);
  assert.equal(computeReadiness(inp).components.hrv, undefined);
});

test('buildInputs: sleep score and 3-night history', () => {
  const sleep = [{ date: D, score: 80 }, { date: day(-1), score: 70 }, { date: day(-2), score: 60 }, { date: day(-3), score: 10 }];
  const inp = buildInputs(D, { sleep });
  assert.equal(inp.sleepScore, 80);
  assert.deepEqual(inp.sleepHistory, [80, 70, 60]);
  // a single night is not a history
  assert.equal(buildInputs(D, { sleep: [{ date: D, score: 80 }] }).sleepHistory, undefined);
});

test('buildInputs: Garmin load windows end yesterday', () => {
  const metrics = [{ date: D, load: 1000 }]; // today: ignored
  for (let i = 1; i <= 28; i++) metrics.push({ date: day(-i), load: 10 });
  metrics.push({ date: day(-29), load: 1000 }); // outside the window
  const inp = buildInputs(D, { metrics });
  assert.deepEqual(inp.load, { acute: 70, chronic: 280, source: 'garmin' });
});

test('buildInputs: falls back to planned durations when Garmin has no load', () => {
  const planned = [];
  for (let i = 1; i <= 28; i++) planned.push({ date: day(-i), dur: 60 });
  planned.push({ date: D, dur: 600 });
  const inp = buildInputs(D, { metrics: [{ date: day(-1), hrv: 50 }], planned });
  assert.deepEqual(inp.load, { acute: 420, chronic: 1680, source: 'planned' });
  assert.equal(computeReadiness(inp).components.load.label, 'Optimal');
});

test('buildInputs: no data at all gives empty inputs', () => {
  assert.deepEqual(buildInputs(D, {}), {});
  assert.equal(computeReadiness(buildInputs(D, {})).score, null);
});
