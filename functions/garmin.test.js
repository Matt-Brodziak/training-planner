// Run: cd functions && npm test
// Fixtures copy the shape of real Garmin Personal API responses (Nov 2026) with made-up values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseHrv, normaliseDailySummaries, normaliseActivities, activityLoad, normaliseSleep } from './garmin.js';

test('HRV summaries', () => {
  const body = {
    hrvSummaries: [
      { calendarDate: '2026-11-04', weeklyAvg: 100, lastNightAvg: 110, lastNight5MinHigh: 140, baseline: { balancedLow: 90, balancedUpper: 140 }, status: 'BALANCED' },
      { calendarDate: '2026-11-05', weeklyAvg: 101, lastNightAvg: null, status: 'BALANCED' },
    ],
    userProfilePk: 1,
  };
  assert.deepEqual(normaliseHrv(body), [
    { date: '2026-11-04', hrv: 110, hrvWeekly: 100, hrvStatus: 'BALANCED' },
    { date: '2026-11-05', hrv: null, hrvWeekly: 101, hrvStatus: 'BALANCED' },
  ]);
  assert.deepEqual(normaliseHrv(null), []);
});

test('daily summaries: resting HR and stress are nested', () => {
  const body = { data: [
    { calendarDate: '2026-11-04', heartRate: { minValue: 40, maxValue: 120, restingValue: 44 }, stress: { avgLevel: 30, maxLevel: 90 } },
    { calendarDate: '2026-11-05', heartRate: {}, stress: {} },
  ] };
  assert.deepEqual(normaliseDailySummaries(body), [
    { date: '2026-11-04', rhr: 44, stress: 30 },
    { date: '2026-11-05', rhr: null, stress: null },
  ]);
});

test('activity load: Edwards TRIMP from heart-rate zone seconds', () => {
  // 10 min in each zone: 10×1 + 10×2 + 10×3 + 10×4 + 10×5 = 150
  const a = { duration: 3000, hrTimeInZone_1: 600, hrTimeInZone_2: 600, hrTimeInZone_3: 600, hrTimeInZone_4: 600, hrTimeInZone_5: 600 };
  assert.equal(activityLoad(a), 150);
  // no HR zones: whole duration counts as zone 2
  assert.equal(activityLoad({ duration: 1800 }), 60);
  assert.equal(activityLoad({}), null);
});

test('activities: dated by local start, load per activity', () => {
  const body = [
    { activityId: 1, startTimeLocal: '2026-11-04 17:13:28', duration: 1200, hrTimeInZone_3: 1200 },
    { activityId: 2, startTimeLocal: '2026-11-05 06:00:00', duration: 900 },
    { activityId: 3, duration: 600 },
  ];
  assert.deepEqual(normaliseActivities(body), [
    { date: '2026-11-04', load: 60, durationMin: 20 },
    { date: '2026-11-05', load: 30, durationMin: 15 },
  ]);
});

test('sleep: flat payload with nested overall score', () => {
  const r = normaliseSleep('2026-11-05', {
    calendarDate: '2026-11-05', sleepTimeSeconds: 27000, deepSleepSeconds: 6000, lightSleepSeconds: 17000, remSleepSeconds: 3500, awakeSleepSeconds: 60,
    avgHeartRate: 45, avgSleepStress: 9, averageRespirationValue: 14, sleepScores: { overall: { value: 87, qualifierKey: 'GOOD' } },
  });
  assert.equal(r.hasData, true);
  assert.equal(r.score, 87);
  assert.equal(r.scoreLabel, 'GOOD');
  assert.equal(r.totalSec, 27000);
});
