// MCP connector for the Training Planner.
// Lets Claude read and write your plans, calendar workouts and library through a
// small set of tools. It speaks MCP's Streamable HTTP transport (stateless, JSON replies),
// so it runs as one ordinary HTTPS Cloud Function with no extra dependencies.
//
// Data shapes match what index.html writes:
//   users/{uid}/plans/{id}     { name, color, created }
//   users/{uid}/workouts/{id}  { disc, title, dur (min), dist (km), notes, race, prio, date, plan, order, created }
//   users/{uid}/library/{id}   { disc, title, dur (min), dist (km), notes, race, prio, created }

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

const SERVER = { name: 'training-planner', version: '1.0.0' };
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DISCS = ['run', 'bike', 'swim', 'strength', 'other'];
const PRIOS = ['A', 'B', 'C'];
const PLAN_COLORS = ['#F27BAE', '#6E4BD1', '#E0A100', '#2E9E95', '#D4485F', '#4F7FD6', '#8B8F2A', '#9A90B3'];
const BASE = { id: 'base', name: 'Base', color: '#9A90B3', created: 0 };
const MAX_ITEMS = 200;      // per call; one Firestore batch holds 500 writes
const MAX_RANGE_DAYS = 800; // widest window list_workouts will return
const MIN_TOKEN_LEN = 24;

const INSTRUCTIONS = [
  'Tools for one athlete\'s personal Training Planner (planning only: there is no record of completed workouts).',
  'Dates are YYYY-MM-DD in the athlete\'s local time; weeks run Monday to Sunday. Call list_plans first: it returns today\'s date and the plan ids.',
  'Durations are minutes. Distances are kilometres for every discipline, including swims (a 2 500 m swim is 2.5).',
  'Put the session structure (warm-up, intervals, targets, fuelling) in notes as plain text with line breaks.',
  'Before adding a block of workouts, list the same date range so you do not duplicate sessions that are already there.',
].join(' ');

/* ---------- tool definitions ---------- */
const workoutProps = {
  date: { type: 'string', description: 'YYYY-MM-DD' },
  discipline: { type: 'string', enum: DISCS },
  title: { type: 'string', description: 'Short name shown on the calendar card, e.g. "Tempo run"' },
  duration_min: { type: 'number', description: 'Planned duration in minutes. 0 or omit if not set.' },
  distance_km: { type: 'number', description: 'Planned distance in km (swims too: 2500 m = 2.5). 0 or omit if not set.' },
  notes: { type: 'string', description: 'Structure, targets, fuelling, route. Plain text, line breaks allowed.' },
  plan: { type: 'string', description: 'Plan id or plan name. Defaults to default_plan, else the Base plan.' },
  race: { type: 'boolean', description: 'True for a training race or goal race.' },
  priority: { type: 'string', enum: PRIOS, description: 'Race priority. Only used when race is true; defaults to B.' },
};
const { date: _d, plan: _p, ...libraryProps } = workoutProps;

const TOOLS = [
  {
    name: 'list_plans',
    title: 'List plans',
    description: 'List every training plan with its id, colour, workout count and first/last workout date. Also returns today\'s date in the athlete\'s timezone. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_plan',
    title: 'Create plan',
    description: 'Create a new training plan (a named, colour-coded group of workouts). If a plan with the same name already exists it is returned instead of creating a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'e.g. "Marathon block"' },
        color: { type: 'string', enum: PLAN_COLORS, description: 'Optional. Defaults to the first colour no other plan uses.' },
      },
      required: ['name'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'list_workouts',
    title: 'List workouts',
    description: 'List calendar workouts between two dates (inclusive), sorted by date. Optionally filter to one plan. Includes weekly totals per discipline.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        plan: { type: 'string', description: 'Optional plan id or name.' },
      },
      required: ['from', 'to'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_workouts',
    title: 'Add workouts',
    description: `Add up to ${MAX_ITEMS} workouts to the calendar in one call. All-or-nothing: if any workout is invalid, none are written. For a longer block, call again with the next batch.`,
    inputSchema: {
      type: 'object',
      properties: {
        default_plan: { type: 'string', description: 'Plan id or name applied to workouts that do not name their own plan.' },
        workouts: {
          type: 'array', minItems: 1, maxItems: MAX_ITEMS,
          items: { type: 'object', properties: workoutProps, required: ['date', 'discipline', 'title'], additionalProperties: false },
        },
      },
      required: ['workouts'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'update_workouts',
    title: 'Update workouts',
    description: `Change up to ${MAX_ITEMS} existing workouts. Give each workout's id plus only the fields to change (for example a new date to move it). Fields you leave out keep their current value. All-or-nothing.`,
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array', minItems: 1, maxItems: MAX_ITEMS,
          items: { type: 'object', properties: { id: { type: 'string' }, ...workoutProps }, required: ['id'], additionalProperties: false },
        },
      },
      required: ['updates'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'delete_workouts',
    title: 'Delete workouts',
    description: `Permanently delete up to ${MAX_ITEMS} calendar workouts by id. This cannot be undone, so confirm with the athlete before deleting anything they did not explicitly ask to remove.`,
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', minItems: 1, maxItems: MAX_ITEMS, items: { type: 'string' } } },
      required: ['ids'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'list_library',
    title: 'List library workouts',
    description: 'List the reusable workout templates in the library, optionally for one discipline.',
    inputSchema: {
      type: 'object',
      properties: { discipline: { type: 'string', enum: DISCS } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_library_workouts',
    title: 'Add library workouts',
    description: `Add up to ${MAX_ITEMS} reusable workout templates to the library. Templates have no date or plan. All-or-nothing.`,
    inputSchema: {
      type: 'object',
      properties: {
        workouts: {
          type: 'array', minItems: 1, maxItems: MAX_ITEMS,
          items: { type: 'object', properties: libraryProps, required: ['discipline', 'title'], additionalProperties: false },
        },
      },
      required: ['workouts'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

/* ---------- helpers ---------- */
class ToolError extends Error {}
const fail = msg => { throw new ToolError(msg); };

const newId = p => p + Date.now().toString(36) + randomBytes(4).toString('hex').slice(0, 5);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

function checkDate(v, label) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(`${label} must be a date like 2027-01-11.`);
  const d = new Date(v + 'T12:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail(`${label} "${v}" is not a real calendar date.`);
  return v;
}
function checkNum(v, label, max) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) fail(`${label} must be a number between 0 and ${max}.`);
  return n;
}
function checkList(v, label) {
  if (!Array.isArray(v) || !v.length) fail(`${label} must be a non-empty list.`);
  if (v.length > MAX_ITEMS) fail(`${label} has ${v.length} items; the limit is ${MAX_ITEMS} per call. Send the rest in a second call.`);
  return v;
}
const mondayOf = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5);

// Turn tool input into the fields the app stores. `partial` = only validate fields that are present.
function toStored(input, where, { partial = false, dated = true } = {}) {
  if (!isObj(input)) fail(`${where} must be an object.`);
  const out = {};
  const has = k => input[k] !== undefined;
  if (dated && (has('date') || !partial)) out.date = checkDate(input.date, `${where}: date`);
  if (has('discipline') || !partial) {
    if (!DISCS.includes(input.discipline)) fail(`${where}: discipline must be one of ${DISCS.join(', ')}.`);
    out.disc = input.discipline;
  }
  if (has('title') || !partial) {
    const t = typeof input.title === 'string' ? input.title.trim() : '';
    if (!t) fail(`${where}: title is required.`);
    if (t.length > 200) fail(`${where}: title is longer than 200 characters.`);
    out.title = t;
  }
  if (has('duration_min') || !partial) out.dur = Math.round(checkNum(input.duration_min, `${where}: duration_min`, 2880));
  if (has('distance_km') || !partial) out.dist = +checkNum(input.distance_km, `${where}: distance_km`, 2000).toFixed(3);
  if (has('notes') || !partial) {
    if (has('notes') && typeof input.notes !== 'string') fail(`${where}: notes must be text.`);
    if ((input.notes || '').length > 20000) fail(`${where}: notes are longer than 20 000 characters.`);
    out.notes = input.notes || '';
  }
  if (has('race') || !partial) {
    if (has('race') && typeof input.race !== 'boolean') fail(`${where}: race must be true or false.`);
    out.race = !!input.race;
  }
  if (has('priority')) {
    if (!PRIOS.includes(input.priority)) fail(`${where}: priority must be A, B or C.`);
    out.prio = input.priority;
  }
  return out;
}
// The app stores prio as 'A'/'B'/'C' for races and '' otherwise.
const fixPrio = w => { w.prio = w.race ? (PRIOS.includes(w.prio) ? w.prio : 'B') : ''; return w; };

function fromStored(id, w, planMap) {
  const planId = w.plan || 'base';
  const o = {
    id, date: w.date, discipline: DISCS.includes(w.disc) ? w.disc : 'other', title: w.title || '',
    duration_min: +w.dur || 0, distance_km: +w.dist || 0, notes: w.notes || '',
    plan_id: planId, plan_name: planMap?.get(planId)?.name ?? null, race: !!w.race,
  };
  if (w.race) o.priority = w.prio || 'B';
  return o;
}
function fromStoredTemplate(id, t) {
  const o = { id, discipline: DISCS.includes(t.disc) ? t.disc : 'other', title: t.title || '', duration_min: +t.dur || 0, distance_km: +t.dist || 0, notes: t.notes || '', race: !!t.race };
  if (t.race) o.priority = t.prio || 'B';
  return o;
}

/* ---------- the tools ---------- */
function makeTools({ db, getUid, tz }) {
  const userRef = () => {
    const uid = getUid();
    if (!uid || uid.startsWith('PASTE')) throw new Error('OWNER_UID is not set in functions/.env');
    return db.collection('users').doc(uid);
  };
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

  async function loadPlans() {
    const snap = await userRef().collection('plans').get();
    const map = new Map([['base', { ...BASE }]]);
    snap.forEach(d => { map.set(d.id, { ...(d.id === 'base' ? BASE : {}), ...d.data(), id: d.id }); });
    return map;
  }
  function resolvePlan(ref, planMap, where) {
    if (ref === undefined || ref === null || ref === '') return 'base';
    if (typeof ref !== 'string') fail(`${where}: plan must be a plan id or name.`);
    if (planMap.has(ref)) return ref;
    const wanted = ref.trim().toLowerCase();
    const hits = [...planMap.values()].filter(p => String(p.name || '').trim().toLowerCase() === wanted);
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) fail(`${where}: more than one plan is called "${ref}". Use the plan id instead.`);
    fail(`${where}: there is no plan "${ref}". Existing plans: ${[...planMap.values()].map(p => `${p.name} (${p.id})`).join(', ')}. Create it first with create_plan.`);
  }

  return {
    async list_plans() {
      const planMap = await loadPlans();
      const snap = await userRef().collection('workouts').select('plan', 'date').get();
      const stats = new Map();
      snap.forEach(d => {
        const w = d.data(), id = w.plan || 'base';
        const s = stats.get(id) || { n: 0, first: null, last: null };
        s.n++;
        if (w.date && (!s.first || w.date < s.first)) s.first = w.date;
        if (w.date && (!s.last || w.date > s.last)) s.last = w.date;
        stats.set(id, s);
      });
      const plans = [...planMap.values()].sort((a, b) => (a.id === 'base' ? -1 : b.id === 'base' ? 1 : (a.created || 0) - (b.created || 0)))
        .map(p => ({ id: p.id, name: p.name, color: p.color, workouts: stats.get(p.id)?.n || 0, first_workout: stats.get(p.id)?.first || null, last_workout: stats.get(p.id)?.last || null }));
      return { today: today(), timezone: tz, plans };
    },

    async create_plan(a) {
      const name = typeof a.name === 'string' ? a.name.trim() : '';
      if (!name) fail('name is required.');
      if (name.length > 80) fail('name is longer than 80 characters.');
      if (a.color !== undefined && !PLAN_COLORS.includes(a.color)) fail(`color must be one of ${PLAN_COLORS.join(', ')}.`);
      const planMap = await loadPlans();
      const existing = [...planMap.values()].find(p => String(p.name || '').trim().toLowerCase() === name.toLowerCase());
      if (existing) return { already_existed: true, plan: { id: existing.id, name: existing.name, color: existing.color } };
      const used = [...planMap.values()].map(p => String(p.color).toLowerCase());
      const color = a.color || PLAN_COLORS.find(c => !used.includes(c.toLowerCase())) || PLAN_COLORS[0];
      const id = newId('p');
      await userRef().collection('plans').doc(id).set({ name, color, created: Date.now() });
      return { already_existed: false, plan: { id, name, color } };
    },

    async list_workouts(a) {
      const from = checkDate(a.from, 'from'), to = checkDate(a.to, 'to');
      if (to < from) fail('to is before from.');
      if (daysBetween(from, to) > MAX_RANGE_DAYS) fail(`That range is longer than ${MAX_RANGE_DAYS} days. Ask for a shorter window.`);
      const planMap = await loadPlans();
      const planId = a.plan ? resolvePlan(a.plan, planMap, 'plan') : null;
      const snap = await userRef().collection('workouts').where('date', '>=', from).where('date', '<=', to).get();
      const rows = [];
      snap.forEach(d => { const w = d.data(); if (!planId || (w.plan || 'base') === planId) rows.push({ id: d.id, w }); });
      rows.sort((x, y) => x.w.date.localeCompare(y.w.date) || (x.w.order || 0) - (y.w.order || 0));
      const weeks = new Map();
      for (const { w } of rows) {
        const k = mondayOf(w.date), disc = DISCS.includes(w.disc) ? w.disc : 'other';
        const wk = weeks.get(k) || { week_starting: k, sessions: 0, duration_min: 0, distance_km: 0, by_discipline: {} };
        const bd = wk.by_discipline[disc] || (wk.by_discipline[disc] = { sessions: 0, duration_min: 0, distance_km: 0 });
        for (const t of [wk, bd]) { t.sessions++; t.duration_min += +w.dur || 0; t.distance_km = +(t.distance_km + (+w.dist || 0)).toFixed(3); }
        weeks.set(k, wk);
      }
      return { from, to, count: rows.length, workouts: rows.map(r => fromStored(r.id, r.w, planMap)), weekly_totals: [...weeks.values()] };
    },

    async add_workouts(a) {
      const items = checkList(a.workouts, 'workouts');
      const planMap = await loadPlans();
      const defaultPlan = resolvePlan(a.default_plan, planMap, 'default_plan');
      const now = Date.now();
      const docs = items.map((it, i) => {
        const where = `workouts[${i}]`;
        const w = fixPrio(toStored(it, where));
        w.plan = isObj(it) && it.plan ? resolvePlan(it.plan, planMap, where) : defaultPlan;
        w.order = now + i; w.created = now;
        return { id: newId('w'), w };
      });
      const col = userRef().collection('workouts');
      const batch = db.batch();
      docs.forEach(({ id, w }) => batch.set(col.doc(id), w));
      await batch.commit();
      const dates = docs.map(d => d.w.date).sort();
      return { added: docs.length, first_date: dates[0], last_date: dates[dates.length - 1], workouts: docs.map(d => ({ id: d.id, date: d.w.date, title: d.w.title, plan_id: d.w.plan })) };
    },

    async update_workouts(a) {
      const items = checkList(a.updates, 'updates');
      items.forEach((it, i) => { if (!isObj(it) || typeof it.id !== 'string' || !ID_RE.test(it.id)) fail(`updates[${i}]: a valid workout id is required.`); });
      if (new Set(items.map(it => it.id)).size !== items.length) fail('The same workout id appears more than once in updates.');
      const planMap = await loadPlans();
      const col = userRef().collection('workouts');
      const snaps = await Promise.all(items.map(it => col.doc(it.id).get()));
      const missing = items.filter((_, i) => !snaps[i].exists).map(it => it.id);
      if (missing.length) fail(`No workout with id: ${missing.join(', ')}. Nothing was changed.`);
      const now = Date.now();
      const docs = items.map((it, i) => {
        const where = `updates[${i}]`;
        const cur = snaps[i].data();
        const patch = toStored(it, where, { partial: true });
        if (it.plan !== undefined) patch.plan = resolvePlan(it.plan, planMap, where);
        const next = fixPrio({ ...cur, ...patch });
        if (patch.date && patch.date !== cur.date) next.order = now + i; // moved: goes to the end of its new day
        return { id: it.id, next };
      });
      const batch = db.batch();
      docs.forEach(({ id, next }) => batch.set(col.doc(id), next));
      await batch.commit();
      return { updated: docs.length, workouts: docs.map(d => fromStored(d.id, d.next, planMap)) };
    },

    async delete_workouts(a) {
      const ids = checkList(a.ids, 'ids');
      ids.forEach((id, i) => { if (typeof id !== 'string' || !ID_RE.test(id)) fail(`ids[${i}] is not a valid workout id.`); });
      const uniq = [...new Set(ids)];
      const col = userRef().collection('workouts');
      const snaps = await Promise.all(uniq.map(id => col.doc(id).get()));
      const found = [], notFound = [];
      uniq.forEach((id, i) => { if (snaps[i].exists) { const w = snaps[i].data(); found.push({ id, date: w.date, title: w.title }); } else notFound.push(id); });
      if (found.length) { const batch = db.batch(); found.forEach(f => batch.delete(col.doc(f.id))); await batch.commit(); }
      return { deleted: found.length, deleted_workouts: found, not_found: notFound };
    },

    async list_library(a) {
      if (a.discipline !== undefined && !DISCS.includes(a.discipline)) fail(`discipline must be one of ${DISCS.join(', ')}.`);
      const snap = await userRef().collection('library').get();
      const rows = [];
      snap.forEach(d => { const t = fromStoredTemplate(d.id, d.data()); if (!a.discipline || t.discipline === a.discipline) rows.push(t); });
      rows.sort((x, y) => DISCS.indexOf(x.discipline) - DISCS.indexOf(y.discipline) || x.title.localeCompare(y.title));
      return { count: rows.length, library: rows };
    },

    async add_library_workouts(a) {
      const items = checkList(a.workouts, 'workouts');
      const now = Date.now();
      const docs = items.map((it, i) => ({ id: newId('t'), t: { ...fixPrio(toStored(it, `workouts[${i}]`, { dated: false })), created: now } }));
      const col = userRef().collection('library');
      const batch = db.batch();
      docs.forEach(({ id, t }) => batch.set(col.doc(id), t));
      await batch.commit();
      return { added: docs.length, library: docs.map(d => ({ id: d.id, title: d.t.title, discipline: d.t.disc })) };
    },
  };
}

/* ---------- JSON-RPC / HTTP ---------- */
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function sameToken(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const h = s => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(expected));
}

/**
 * @param {object} o
 * @param {FirebaseFirestore.Firestore} o.db
 * @param {() => string} o.getUid    owner's Firebase user ID
 * @param {() => string} o.getToken  shared secret the connector must present
 * @param {string} o.tz              IANA timezone used for "today"
 * @param {{info:Function,error:Function}} [o.log]
 */
export function createMcpHandler({ db, getUid, getToken, tz, log = console }) {
  const tools = makeTools({ db, getUid, tz });

  async function handle(msg) {
    if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(isObj(msg) ? msg.id : null, -32600, 'Invalid request');
    const isNotification = !('id' in msg);
    const { id, method } = msg;
    const params = isObj(msg.params) ? msg.params : {};
    if (isNotification) return null; // notifications/initialized, notifications/cancelled: nothing to do
    switch (method) {
      case 'initialize':
        return { jsonrpc: '2.0', id, result: {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER,
          instructions: INSTRUCTIONS,
        } };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const fn = Object.hasOwn(tools, params.name) ? tools[params.name] : null;
        if (!fn) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
        const args = params.arguments === undefined ? {} : params.arguments;
        try {
          if (!isObj(args)) fail('Tool arguments must be an object.');
          const out = await fn(args);
          log.info(`mcp tool ${params.name} ok`);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false } };
        } catch (err) {
          const expected = err instanceof ToolError;
          if (!expected) log.error(`mcp tool ${params.name} failed`, err);
          const text = expected ? err.message : 'The planner could not complete that. Check the function logs in the Firebase console.';
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return async function mcpHttp(req, res) {
    res.set('Cache-Control', 'no-store');
    const expected = getToken();
    if (!expected || expected.length < MIN_TOKEN_LEN) {
      log.error('MCP_TOKEN is missing or too short; refusing all requests.');
      res.status(503).json({ error: 'Connector is not configured.' });
      return;
    }
    // Token arrives as "Authorization: Bearer <token>" (preferred) or as the last URL path segment.
    const auth = req.get('authorization') || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
    const pathToken = String(req.path || '').split('/').filter(Boolean).pop();
    if (!sameToken(bearer, expected) && !sameToken(pathToken, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (req.method !== 'POST') {
      // No server-initiated streams and no sessions, so GET and DELETE are not offered.
      res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed. Use POST.'));
      return;
    }
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = undefined; } }
    if (body === undefined || body === null || (Array.isArray(body) && !body.length)) {
      res.status(400).json(rpcError(null, -32700, 'Parse error'));
      return;
    }
    try {
      if (Array.isArray(body)) {
        const out = [];
        for (const m of body) { const r = await handle(m); if (r) out.push(r); }
        if (out.length) res.status(200).json(out); else res.status(202).end();
      } else {
        const r = await handle(body);
        if (r) res.status(200).json(r); else res.status(202).end();
      }
    } catch (err) {
      log.error('mcp request failed', err);
      res.status(500).json(rpcError(isObj(body) ? body.id : null, -32603, 'Internal error'));
    }
  };
}