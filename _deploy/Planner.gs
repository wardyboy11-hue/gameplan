/* Planner.gs: the daily plan Rohan books (Prompt 22, stage 1).
   The app does the admin. Rohan chooses WHEN, not WHETHER.
   Locking: the actions that write are listed in WRITES and already hold the script lock. Trigger entries take it themselves. */
var G2_ACTIONS = (typeof G2_ACTIONS === 'undefined') ? {} : G2_ACTIONS;

var LEVEL_NAMES = { 1: 'OPERATOR', 2: 'CO-PILOT', 3: 'PILOT' };
var LEVEL_CAP = { 1: 90, 2: 105, 3: 120 };
var CUES = ['I get home and eat', 'I sit down at my desk', 'my break ends'];
var RETRIEVAL_DAYS = [10, 6, 3, 1];
var OFF_REASONS = { ill: 'not feeling well', match: 'match day', family: 'family', other: 'something else' };
var ACTIVE_STATES = ['suggested', 'committed', 'done'];

function p22Now_() { return new Date(); }
function nowMin_() { var d = p22Now_(); return Number(Utilities.formatDate(d, tz_(), 'H')) * 60 + Number(Utilities.formatDate(d, tz_(), 'm')); }
function lvl_() { var n = Number(getSetting('operatorLevel')); return n >= 1 && n <= 3 ? n : 1; }
function setting_(k) { return String(getSetting(k)); }
function blockMins_(b) { return minutesOf_(b.end) - minutesOf_(b.start); }
function blockIds_(b) { try { return JSON.parse(b.agendaIds || '[]'); } catch (e) { return []; } }

/* ---------- limits for a day ---------- */
function examFortnight_(date) {
  var soon = function (d) { return d && d >= date && daysBetween_(date, d) <= 14; };
  return keyDates_().some(function (k) { return (k.type === 'exam' || k.type === 'mock') && soon(k.startDate); }) ||
    getRows('Agenda', function (a) { return a.type === 'mock' && a.status !== 'done' && a.status !== 'dismissed' && soon(a.dueDate); }).length > 0;
}
function capFor_(date) {
  var info = dayInfo_(date), cap;
  if (info.holidayMode) cap = 60;
  else if (info.weekend) cap = 120;
  else cap = LEVEL_CAP[lvl_()];
  if (examFortnight_(date)) cap += 30;
  return cap;
}

/* ---------- free time ---------- */
function availabilityFor_(date) {
  var d = dayName_(date), prep = Number(getSetting('prepBuffer')) || 0, off = [];
  getRows('Availability', function (r) { return r.day === d; }).forEach(function (r) {
    var from = minutesOf_(r.fromTime), to = minutesOf_(r.toTime);
    off.push({ from: p22Bool_(r.hard) ? Math.max(0, from - prep) : from, to: to, label: r.label, hard: p22Bool_(r.hard), shownFrom: from });
  });
  return off;
}
function subtractRanges_(free, cut) {
  var out = [];
  free.forEach(function (f) {
    if (cut.to <= f.from || cut.from >= f.to) { out.push(f); return; }
    if (cut.from > f.from) out.push({ from: f.from, to: cut.from });
    if (cut.to < f.to) out.push({ from: cut.to, to: f.to });
  });
  return out;
}
function activeBlocks_(date) { return getRows('Blocks', function (b) { return b.date === date && ACTIVE_STATES.indexOf(b.state) > -1; }); }
/** Study start for a date: after school on school days, later on weekends and holidays. */
function dayStart_(date) {
  var info = dayInfo_(date);
  if (info.weekend || info.holidayMode) return minutesOf_(setting_('weekendStart'));
  if (info.earlyClose) return minutesOf_(info.earlyClose) + 45;
  return minutesOf_(setting_('homeBy'));
}
function freeSlots_(date, opts) {
  opts = opts || {};
  if (setting_('offToday') === date) return [];
  var free = [{ from: dayStart_(date), to: minutesOf_(setting_('latestStudyEnd')) }];
  availabilityFor_(date).forEach(function (a) { free = subtractRanges_(free, a); });
  activeBlocks_(date).forEach(function (b) {
    if (opts.ignoreBlock && b.blockId === opts.ignoreBlock) return;
    if (opts.keepSuggested === false && b.state === 'suggested') return;
    if (b.state === 'suggested' && opts.ignoreSuggested) return;
    free = subtractRanges_(free, { from: minutesOf_(b.start), to: minutesOf_(b.end) + 10 });
  });
  if (date === today_()) { var n = Math.ceil((nowMin_() + 5) / 5) * 5; free = subtractRanges_(free, { from: 0, to: n }); }
  return free.filter(function (f) { return f.to - f.from >= 15; });
}

/* ---------- what needs doing ---------- */
function splitChunks_(label, mins, adapt) {
  var maxLen = Math.min(40, (adapt && adapt.chunkMax) || 40);
  if (/sparx/i.test(label) && mins < 90) mins = 90;
  if (mins <= maxLen) return [{ label: label, minutes: Math.max(10, mins), order: 1 }];
  var n = Math.ceil(mins / Math.min(maxLen, 30)), each = Math.max(15, Math.round(mins / n / 5) * 5), out = [];
  for (var i = 1; i <= n; i++) out.push({ label: label + ' ' + i + '/' + n, minutes: Math.min(maxLen, each), order: i });
  return out;
}
function displayName_(subject, title) {
  var s = String(subject || ''), t = String(title || '');
  return (!s || s === 'Other' || t.toLowerCase().indexOf(s.toLowerCase()) > -1) ? t : s + ' ' + t;
}
function getAdapt_(item) {
  try {
    var raw = item.source === 'agenda' ? getRows('Agenda', function (a) { return a.id === item.id; })[0].adapt : settingRaw_('adapt:' + item.id);
    return JSON.parse(raw || '{}');
  } catch (e) { return {}; }
}
function setAdapt_(itemId, patch) {
  var isHw = itemId.indexOf('hw:') === 0, cur = {};
  var a = isHw ? null : getRows('Agenda', function (x) { return x.id === itemId; })[0];
  try { cur = JSON.parse((isHw ? settingRaw_('adapt:' + itemId) : (a && a.adapt)) || '{}'); } catch (e) {}
  Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
  if (isHw) upsertRow('Settings', { key: 'adapt:' + itemId, value: JSON.stringify(cur) }, 'key');
  else if (a) upsertRow('Agenda', { id: a.id, adapt: JSON.stringify(cur) }, 'id');
  return cur;
}

var ESTIMATE_SYSTEM = 'You are a UK KS4 study planner. Estimate realistic minutes for a 15-year-old Higher-tier student to complete this task well. Split anything over 40 min into chunks of 20-40 min with concrete verbs. Return JSON only. Schema: {"estMinutes":int,"chunks":[{"label":str,"minutes":int,"order":int}],"parts":[str],"retrievalTopics":[str]}';
/** Claude estimate for one Agenda row, cached by title and details. Falls back to a plain rule. */
function estimateAgenda_(a, budget) {
  var h = hash_(a.title + '|' + a.details), cached = null;
  if (a.estHash === h) { try { cached = JSON.parse(a.chunks || '[]'); } catch (e) {} }
  if (cached && cached.length) return cached;
  var base = /sparx/i.test(a.title) ? 90 : 30, chunks = null;
  if (budget && budget.left > 0 && props_().getProperty('ANTHROPIC_KEY')) {
    budget.left--;
    try {
      var out = callClaude_(ESTIMATE_SYSTEM, [{ role: 'user', content: JSON.stringify({ subject: a.subject, title: a.title, details: a.details, dueDate: a.dueDate }) }], 700);
      var list = (out.chunks || []).filter(function (c) { return c && Number(c.minutes) >= 10 && Number(c.minutes) <= 60; }).slice(0, 6).map(function (c, i) { return { label: clip_(c.label, 60) || (a.title + ' ' + (i + 1)), minutes: Math.min(40, Math.round(Number(c.minutes))), order: i + 1 }; });
      if (list.length) {
        if (/sparx/i.test(a.title) && list.length < 3) list = splitChunks_(a.title, 90, null);
        chunks = list;
        upsertRow('Agenda', { id: a.id, estMinutes: String(Math.max(10, Math.min(240, Number(out.estMinutes) || list.reduce(function (s, c) { return s + c.minutes; }, 0)))), chunks: JSON.stringify(list), estHash: h }, 'id');
      }
    } catch (e) { log_('system', 'estfail', String(e).slice(0, 100)); }
  }
  return chunks || splitChunks_(a.title, base, null);
}

/** Everything that could take a block of time, in one shape. Arbor rows come first, then Homework rows that are not the same task. */
function planItems_(budget) {
  var items = [];
  var agenda = getRows('Agenda', function (a) {
    return ['homework', 'test', 'mock'].indexOf(a.type) > -1 && a.status !== 'done' && a.status !== 'dismissed' && a.progressState !== 'done' &&
      a.backlog !== 'check' && a.backlog !== 'ignored' && a.arborMissing !== 'TRUE' && a.audience !== 'parents';
  });
  agenda.forEach(function (a) {
    var isTest = a.type === 'test' || a.type === 'mock';
    var it = { id: a.id, source: 'agenda', type: a.type, subject: a.subject, title: a.title, name: displayName_(a.subject, a.title), dueDate: a.dueDate, retrieval: isTest, hardDue: !!a.dueDate };
    it.adapt = (function () { try { return JSON.parse(a.adapt || '{}'); } catch (e) { return {}; } })();
    if (isTest) it.chunks = RETRIEVAL_DAYS.map(function (d, i) { return { label: it.name + ' retrieval ' + (i + 1) + '/' + RETRIEVAL_DAYS.length, minutes: 20, order: i + 1, dueOffset: d }; });
    else {
      var est = estimateAgenda_(a, budget);
      if (it.adapt.chunkMax) est = splitChunks_(it.name, est.reduce(function (s, c) { return s + c.minutes; }, 0), it.adapt);
      it.chunks = est.map(function (c) { return { label: displayName_(a.subject, c.label), minutes: c.minutes, order: c.order }; });
    }
    items.push(it);
  });
  getRows('Homework', function (r) { return r.status === 'todo' && r.confirmed !== '0'; }).forEach(function (r) {
    var dup = agenda.some(function (a) { return jaccard_(a.title, r.task) > 0.8 && (!a.dueDate || !r.dueDate || Math.abs(daysBetween_(a.dueDate, r.dueDate)) <= 2); });
    if (dup) return;
    var id = 'hw:' + r.id, name = displayName_(r.subject, r.task);
    var adapt = {}; try { adapt = JSON.parse(settingRaw_('adapt:' + id) || '{}'); } catch (e) {}
    items.push({ id: id, source: 'homework', type: 'homework', subject: r.subject, title: r.task, name: name, dueDate: r.dueDate, retrieval: false, hardDue: !!r.dueDate, adapt: adapt, chunks: splitChunks_(name, Number(r.minutes) || 30, adapt) });
  });
  return items;
}

/** Chunks of an item that no live block covers yet. Retrieval chunks only become due close to the test. */
function uncovered_(item, date) {
  var blocks = getRows('Blocks', function (b) { return ACTIVE_STATES.indexOf(b.state) > -1 && blockIds_(b).indexOf(item.id) > -1; });
  var covered = {}; blocks.forEach(function (b) { covered[b.chunkLabel] = b; });
  return item.chunks.filter(function (c) {
    if (covered[c.label]) return false;
    if (item.retrieval && item.dueDate) { var left = daysBetween_(date, item.dueDate); return left >= 1 && left <= c.dueOffset; }
    return true;
  });
}
function itemScore_(item, date) {
  if (!item.dueDate) return 100;
  var left = daysBetween_(date, item.dueDate);
  if (item.retrieval) return left <= 3 ? 850 - left : 600 - left;
  if (left <= 1) return 1000 - left;
  if (left <= 3) return 800 - left;
  return 300 - left;
}
function mustCoverItems_(items, date) {
  return items.filter(function (it) {
    if (!it.dueDate) return false;
    var left = daysBetween_(date, it.dueDate);
    return it.retrieval ? (left >= 1 && left <= 3) : left <= 1;
  });
}
function committedFor_(itemId) { return getRows('Blocks', function (b) { return (b.state === 'committed' || b.state === 'done') && blockIds_(b).indexOf(itemId) > -1; }); }

/* ---------- the study calendar ---------- */
function studyCal_() { return namedCal_('studyCalId', 'GamePlan'); }
function blockTitle_(b) {
  var m = blockMins_(b);
  return b.state === 'committed' ? '▶ ' + b.chunkLabel + ' · ' + m + 'm' : '◇ SUGGESTED · ' + b.chunkLabel + ' (' + m + 'm)';
}
function dropBlockEvent_(b) {
  if (!b.calEventId) return;
  try { var ev = studyCal_().getEventById(b.calEventId); if (ev) ev.deleteEvent(); } catch (e) {}
  b.calEventId = '';
}
function syncBlockEvent_(b) {
  try {
    dropBlockEvent_(b);
    if (b.state === 'suggested' || b.state === 'committed') {
      var cal = studyCal_(), s = new Date(b.date + 'T' + b.start + ':00'), e = new Date(b.date + 'T' + b.end + ':00');
      var ev = retry_(function () { return cal.createEvent(blockTitle_(b), s, e, { description: b.state === 'committed' ? (b.intention || '') : 'Open GamePlan to lock this in' }); });
      ev.setColor(b.state === 'committed' ? CalendarApp.EventColor.GREEN : CalendarApp.EventColor.GRAY);
      ev.removeAllReminders();
      if (b.state === 'committed') {
        ev.addPopupReminder(10);
        var ad = {}; try { ad = JSON.parse(settingRaw_('adapt:' + blockIds_(b)[0]) || '{}'); } catch (x) {}
        if (ad.extraReminder) ev.addPopupReminder(30);
      }
      b.calEventId = ev.getId();
    }
  } catch (e) { log_('system', 'calfail', 'study cal: ' + String(e).slice(0, 100)); }
  upsertRow('Blocks', b, 'blockId');
}
function setBlock_(b, patch) {
  Object.keys(patch).forEach(function (k) { b[k] = patch[k]; });
  b.updatedAt = nowIso_();
  syncBlockEvent_(b);
  return b;
}

/* ---------- proposing a plan ---------- */
function clearSuggested_(date, before) {
  var rows = getRows('Blocks', function (b) { return b.state === 'suggested' && (before ? b.date < date : b.date === date); });
  rows.forEach(dropBlockEvent_);
  rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (b) { del_('Blocks', b); });
}
function daysLeftForPlan_(item, date) { return item.dueDate ? Math.max(1, daysBetween_(date, item.dueDate) + 1) : 7; }

function planDay_(date, items, run) {
  var level = lvl_();
  clearSuggested_(date);
  var info = dayInfo_(date);
  if (setting_('offToday') === date) return { date: date, placed: 0, unplaced: [] };
  if (level === 3 && !run.force) return { date: date, placed: 0, unplaced: [], pilot: true };
  var cap = capFor_(date), used = activeBlocks_(date).reduce(function (s, b) { return s + blockMins_(b); }, 0);
  var maxBlocks = (info.weekend && !items.some(function (i) { return i.retrieval && i.dueDate && daysBetween_(date, i.dueDate) <= 7; })) ? 2 : 99;
  var count = activeBlocks_(date).length;
  var free = freeSlots_(date), placed = [], unplaced = [], perItemToday = {};
  var order = items.slice().sort(function (a, b) { return itemScore_(b, date) - itemScore_(a, date); });
  order.forEach(function (item) {
    var rem = uncovered_(item, date).filter(function (c) { return !run.taken[item.id + '|' + c.label]; });
    if (!rem.length) return;
    var allowed = item.retrieval ? 1 : (item.dueDate && daysBetween_(date, item.dueDate) <= 1 ? rem.length : Math.ceil(rem.length / daysLeftForPlan_(item, date)));
    rem.slice(0, allowed).forEach(function (c) {
      var need = c.minutes, slot = null, idx = -1;
      if (used + need > cap || count >= maxBlocks) { unplaced.push({ title: c.label, reason: used + need > cap ? 'daily limit' : 'weekend limit' }); return; }
      for (var i = 0; i < free.length; i++) { if (free[i].to - free[i].from >= need) { slot = free[i]; idx = i; break; } }
      if (!slot) { unplaced.push({ title: c.label, reason: 'no free slot' }); return; }
      var start = Math.ceil(slot.from / 5) * 5, end = start + need;
      if (end > slot.to) { unplaced.push({ title: c.label, reason: 'no free slot' }); return; }
      free[idx] = { from: end + 10, to: slot.to };
      free = free.filter(function (f) { return f.to - f.from >= 15; });
      var b = { blockId: 'b_' + uid_(), date: date, start: hm_(start), end: hm_(end), agendaIds: JSON.stringify([item.id]), chunkLabel: c.label, kind: item.retrieval ? 'retrieval' : 'homework', state: 'suggested', intention: '', calEventId: '', createdBy: 'app', movedCount: '0', levelAtCreate: String(level), startedAt: '', handled: '', updatedAt: nowIso_() };
      upsertRow('Blocks', b, 'blockId');
      syncBlockEvent_(b);
      run.taken[item.id + '|' + c.label] = 1;
      used += need; count++; placed.push(b.blockId);
    });
  });
  return { date: date, placed: placed.length, unplaced: unplaced };
}

/** Plan the given dates (default today and tomorrow). */
function proposePlan_(dates, force) {
  seedPlanData_();
  clearSuggested_(today_(), true);
  var budget = { left: 8 }, items = planItems_(budget), run = { taken: {}, force: !!force }, out = [];
  (dates || [today_(), addDays_(today_(), 1)]).forEach(function (d) { out.push(planDay_(d, items, run)); });
  upsertRow('Settings', { key: 'planProposedAt', value: nowIso_() }, 'key');
  return out;
}
function seedPlanData_() { seedKeyDates_(); seedTimetable_(); seedAvailability_(); }
function proposePlanForToday_() { return proposePlan_(null, false); }

/** An Agenda item's due date moved: drop what no longer makes sense. The next proposePlan fills the gaps. */
function replanAgenda_(agendaId) {
  var a = getRows('Agenda', function (x) { return x.id === agendaId; })[0];
  getRows('Blocks', function (b) { return (b.state === 'suggested' || b.state === 'committed') && blockIds_(b).indexOf(agendaId) > -1; }).forEach(function (b) {
    if (b.state === 'suggested' || (a && a.dueDate && b.date > a.dueDate)) setBlock_(b, { state: 'cancelled' });
  });
}

/* ---------- triggers ---------- */
function proposePlanDaily() { var l = LockService.getScriptLock(); l.waitLock(30000); try { return proposePlan_(null, false); } finally { l.releaseLock(); } }
function syncSchoolNightly() { var l = LockService.getScriptLock(); l.waitLock(30000); try { return syncSchoolCalendar(); } finally { l.releaseLock(); } }
function markMissedBlocks() { var l = LockService.getScriptLock(); l.waitLock(30000); try { return markMissed_(); } finally { l.releaseLock(); } }
function markMissed_() {
  var now = p22Now_(), n = 0;
  getRows('Blocks', function (b) { return b.state === 'committed' && !b.startedAt; }).forEach(function (b) {
    var endAt = new Date(b.date + 'T' + b.end + ':00').getTime() + 30 * 60000;
    if (endAt < now.getTime()) { setBlock_(b, { state: 'missed' }); n++; }
  });
  return n;
}
function installPlanTriggers() {
  var ours = ['importArborCsv', 'proposePlanDaily', 'markMissedBlocks', 'syncSchoolNightly'];
  ScriptApp.getProjectTriggers().forEach(function (t) { if (ours.indexOf(t.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('importArborCsv').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(17).create();
  ScriptApp.newTrigger('proposePlanDaily').timeBased().everyDays(1).atHour(6).nearMinute(30).create();
  ScriptApp.newTrigger('markMissedBlocks').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('syncSchoolNightly').timeBased().everyDays(1).atHour(21).create();
  return 'Plan triggers installed: Arbor Sunday 17:00, plan 06:30, missed check every 15 minutes, school calendar 21:00.';
}

/* ---------- the commit rule ---------- */
function commitDeadlineMin_(date) {
  var info = dayInfo_(date);
  if (info.holidayMode) return null;
  var base = minutesOf_(info.weekend ? setting_('commitDeadlineWeekend') : setting_('commitDeadlineSchool'));
  var home = gymArrival_(date);
  return home !== null && home + 30 > base ? home + 30 : base;
}
/** On gym days he gets home at the end of the gym block (about 17:30), so the lock waits until half an hour after that. */
function gymArrival_(date) {
  var d = dayName_(date), best = null;
  getRows('Availability', function (r) { return r.day === d && /gym/i.test(r.label); }).forEach(function (r) { var t = minutesOf_(r.toTime); if (best === null || t > best) best = t; });
  return best;
}
/** Items that need at least one committed block in the next 24 hours, and whether they have it. */
function coverageStatus_(items, t) {
  return mustCoverItems_(items, t).map(function (it) {
    var inDays = [t, addDays_(t, 1)];
    var has = getRows('Blocks', function (b) { return (b.state === 'committed' || b.state === 'done') && blockIds_(b).indexOf(it.id) > -1 && b.date <= (it.dueDate || '9999'); }).length > 0;
    var sugg = getRows('Blocks', function (b) { return b.state === 'suggested' && blockIds_(b).indexOf(it.id) > -1; }).length > 0;
    var possible = uncovered_(it, t).length > 0 || sugg || has;
    return { id: it.id, title: it.name, dueDate: it.dueDate, why: it.retrieval ? 'Test in ' + daysBetween_(t, it.dueDate) + ' day' + (daysBetween_(t, it.dueDate) === 1 ? '' : 's') : (daysBetween_(t, it.dueDate) <= 0 ? 'Due today' : 'Due tomorrow'), covered: has, needed: possible || has };
  }).filter(function (c) { return c.needed; });
}
function pathLocked_(t, items) {
  var next = getRows('Blocks', function (b) { return (b.date === t || b.date === addDays_(t, 1)) && b.state === 'suggested'; });
  if (next.length) return false;
  var cov = coverageStatus_(items, t);
  if (cov.some(function (c) { return !c.covered; })) return false;
  return getRows('Blocks', function (b) { return (b.date === t || b.date === addDays_(t, 1)) && (b.state === 'committed' || b.state === 'done'); }).length > 0;
}
/** +15 XP once a day when the path is locked. Inside the daily cap. */
function awardPathLock_(t, items) {
  if (!pathLocked_(t, items)) return 0;
  var done = getRows('XPLog', function (r) { return r.action === 'pathlock' && String(r.ts).slice(0, 10) === t; }).length;
  if (done) return 0;
  var room = Math.max(0, Number(getSetting('dailyXpCap')) - xpToday_()), xp = Math.min(15, room);
  if (xp > 0) addRow('XPLog', { ts: t + 'T12:00:00', action: 'pathlock', xp: String(xp), note: t });
  else addRow('XPLog', { ts: t + 'T12:00:00', action: 'pathlock', xp: '0', note: 'cap reached' });
  return xp;
}

/* ---------- Rohan's actions ---------- */
function rohanOnly_(role) { if (role !== 'rohan') throw new Error('The plan belongs to Rohan. Mum and dad have their own view.'); }
function findBlock_(id) { var b = getRows('Blocks', function (x) { return x.blockId === id; })[0]; if (!b) throw new Error('Could not find that block.'); return b; }
function intentionText_(label, start, cue) { return 'When ' + (CUES.indexOf(cue) > -1 ? cue : CUES[0]) + ', I will do ' + label + ' at ' + start + ' at my desk.'; }
function blockView_(b) {
  return { blockId: b.blockId, date: b.date, start: b.start, end: b.end, mins: blockMins_(b), label: b.chunkLabel, kind: b.kind, state: b.state, intention: b.intention, createdBy: b.createdBy, started: !!b.startedAt, agendaIds: blockIds_(b) };
}
function dayFrames_(date) {
  var info = dayInfo_(date), frames = [];
  if (info.schoolDay && !info.weekend) frames.push({ from: '08:50', to: info.earlyClose || '15:05', label: 'School', kind: 'school' });
  availabilityFor_(date).forEach(function (a) { frames.push({ from: hm_(a.shownFrom), to: hm_(a.to), label: a.label, kind: 'locked' }); });
  return frames;
}

/* One model of a day, used by Choose your path and by the Week timeline, so they can never disagree. */
function dayModel_(d) {
  var info = dayInfo_(d), blocks = getRows('Blocks', function (b) { return b.date === d && ACTIVE_STATES.indexOf(b.state) > -1; }).sort(function (a, b) { return a.start.localeCompare(b.start); });
  return { date: d, dow: dayName_(d), week: info.week, holidayMode: info.holidayMode, off: setting_('offToday') === d, cap: capFor_(d), used: blocks.reduce(function (s, b) { return s + blockMins_(b); }, 0), frames: dayFrames_(d), blocks: blocks.map(blockView_) };
}
G2_ACTIONS.weekModel = function (role, p) {
  var from = /^\d{4}-\d{2}-\d{2}$/.test(String(p.from || '')) ? p.from : mondayOf_(today_()), days = [];
  for (var i = 0; i < 7; i++) days.push(dayModel_(addDays_(from, i)));
  return { from: from, days: days };
};

G2_ACTIONS.planGet = function (role, p) {
  rohanOnly_(role);
  var t = today_(), tomorrow = addDays_(t, 1), level = lvl_();
  var have = getRows('Blocks', function (b) { return (b.date === t || b.date === tomorrow) && (ACTIVE_STATES.indexOf(b.state) > -1); }).length;
  var proposedToday = settingRaw_('planProposedAt').slice(0, 10) === t;
  if (!proposedToday || (!have && level !== 3)) proposePlan_([t, tomorrow], false);
  var items = planItems_(null), days = [];
  [t, tomorrow].forEach(function (d) {
    var m = dayModel_(d);
    m.label = d === t ? 'Today' : 'Tomorrow';
    m.free = freeSlots_(d, { ignoreSuggested: true }).map(function (f) { return { from: hm_(f.from), to: hm_(f.to) }; });
    days.push(m);
  });
  var dl = commitDeadlineMin_(t), minsLeft = dl === null ? null : dl - nowMin_();
  var cov = coverageStatus_(items, t);
  var missed = getRows('Blocks', function (b) { return b.state === 'missed' && !b.handled && b.date >= addDays_(t, -1); }).map(function (b) {
    var fits = freeSlots_(t, { ignoreSuggested: true }).filter(function (f) { return f.to - f.from >= blockMins_(b); })[0];
    var misses = getRows('Blocks', function (x) { return x.state === 'missed' && blockIds_(x).indexOf(blockIds_(b)[0]) > -1; }).length;
    return { blockId: b.blockId, label: b.chunkLabel, next: fits ? { date: t, start: hm_(Math.ceil(fits.from / 5) * 5), end: hm_(Math.ceil(fits.from / 5) * 5 + blockMins_(b)) } : null, askWhy: misses >= 2, itemId: blockIds_(b)[0] };
  });
  var moved = getRows('Agenda', function (a) { return a.dueChanged === 'TRUE' && a.status !== 'done' && a.backlog !== 'check'; }).map(function (a) { return { id: a.id, title: displayName_(a.subject, a.title), prevDue: a.prevDue, dueDate: a.dueDate }; });
  var coverageWarn = [];
  items.filter(function (i) { return i.retrieval && i.dueDate && daysBetween_(t, i.dueDate) <= 7 && daysBetween_(t, i.dueDate) >= 1; }).forEach(function (i) {
    var n = committedFor_(i.id).length;
    if (n < 2) coverageWarn.push(i.name + ' ' + (daysBetween_(t, i.dueDate) === 1 ? 'is tomorrow' : 'is in ' + daysBetween_(t, i.dueDate) + ' days') + ' and has ' + n + ' block' + (n === 1 ? '' : 's') + '. It usually needs 2.');
  });
  var missions = level === 3 ? items.map(function (i) { return { id: i.id, name: i.name, dueDate: i.dueDate, left: uncovered_(i, t).length, minutes: i.chunks.length ? i.chunks[0].minutes : 30 }; }).filter(function (m) { return m.left > 0; }) : [];
  var locked = pathLocked_(t, items), xp = awardPathLock_(t, items);
  return {
    today: t, tomorrow: tomorrow, level: level, levelName: LEVEL_NAMES[level], days: days, cues: CUES,
    deadline: dl === null ? null : { at: hm_(dl), minsLeft: minsLeft, label: minsLeft > 0 ? 'Path locks in ' + hm_(minsLeft) : 'Path deadline has passed' },
    locked: locked, xp: xp, items: items.filter(function (i) { return uncovered_(i, t).length > 0 || getRows('Blocks', function (b) { return b.state === 'suggested' && blockIds_(b).indexOf(i.id) > -1; }).length > 0; }).map(function (i) { return { id: i.id, name: i.name }; }), mustCover: cov, missed: missed, moved: moved, coverageWarn: coverageWarn, missions: missions, off: setting_('offToday') === t
  };
};

G2_ACTIONS.planAccept = function (role, p) {
  rohanOnly_(role);
  var b = findBlock_(p.blockId);
  if (b.state !== 'suggested') throw new Error('That block is already sorted.');
  setBlock_(b, { state: 'committed', intention: intentionText_(b.chunkLabel, b.start, p.cue) });
  var xp = awardPathLock_(today_(), planItems_(null));
  return { ok: true, xp: xp };
};
G2_ACTIONS.planAcceptAll = function (role, p) {
  rohanOnly_(role);
  var t = today_(), n = 0;
  getRows('Blocks', function (b) { return b.state === 'suggested' && (b.date === t || b.date === addDays_(t, 1)); }).forEach(function (b) { setBlock_(b, { state: 'committed', intention: intentionText_(b.chunkLabel, b.start, p.cue) }); n++; });
  return { accepted: n, xp: awardPathLock_(t, planItems_(null)) };
};
G2_ACTIONS.planMove = function (role, p) {
  rohanOnly_(role);
  var b = findBlock_(p.blockId);
  if (ACTIVE_STATES.indexOf(b.state) < 0 || b.state === 'done') throw new Error('That block cannot be moved.');
  if (!/^\d{2}:\d{2}$/.test(p.start || '')) throw new Error('Pick a time.');
  var date = validDate_(p.date) && (p.date === today_() || p.date === addDays_(today_(), 1)) ? p.date : b.date;
  var len = blockMins_(b), s = minutesOf_(p.start), e = s + len;
  var free = freeSlots_(date, { ignoreBlock: b.blockId });
  var ok = free.some(function (f) { return s >= f.from && e <= f.to; });
  if (!ok) throw new Error('That time is taken, or too late. Pick another.');
  setBlock_(b, { date: date, start: hm_(s), end: hm_(e), state: 'committed', movedCount: String((Number(b.movedCount) || 0) + 1), intention: intentionText_(b.chunkLabel, hm_(s), p.cue) });
  return { ok: true, xp: awardPathLock_(today_(), planItems_(null)) };
};
G2_ACTIONS.planSwap = function (role, p) {
  rohanOnly_(role);
  var b = findBlock_(p.blockId);
  if (b.state !== 'suggested' && b.state !== 'committed') throw new Error('That block cannot be swapped.');
  var items = planItems_(null), other = items.filter(function (i) { return i.id === p.itemId; })[0];
  if (!other) throw new Error('Pick one of your own tasks.');
  var c = uncovered_(other, b.date)[0], stolen = null;
  if (!c) {
    stolen = getRows('Blocks', function (x) { return x.state === 'suggested' && x.blockId !== b.blockId && blockIds_(x).indexOf(other.id) > -1; })[0];
    if (!stolen) throw new Error('That one has nothing left to book.');
    c = { label: stolen.chunkLabel, minutes: blockMins_(stolen) };
  }
  var s = minutesOf_(b.start), e = s + c.minutes;
  var free = freeSlots_(b.date, { ignoreBlock: b.blockId });
  if (!free.some(function (f) { return s >= f.from && e <= f.to; })) throw new Error('That one needs ' + c.minutes + ' minutes and will not fit there. Move it first.');
  setBlock_(b, { state: 'swapped' });
  if (stolen) setBlock_(stolen, { state: 'cancelled' });
  var nb = { blockId: 'b_' + uid_(), date: b.date, start: b.start, end: hm_(e), agendaIds: JSON.stringify([other.id]), chunkLabel: c.label, kind: other.retrieval ? 'retrieval' : 'homework', state: 'committed', intention: '', calEventId: '', createdBy: 'rohan', movedCount: '0', levelAtCreate: String(lvl_()), startedAt: '', handled: '', updatedAt: nowIso_() };
  nb.intention = intentionText_(nb.chunkLabel, nb.start, p.cue);
  upsertRow('Blocks', nb, 'blockId'); syncBlockEvent_(nb);
  return { ok: true, blockId: nb.blockId };
};
G2_ACTIONS.planCancel = function (role, p) {
  rohanOnly_(role);
  var b = findBlock_(p.blockId), t = today_();
  if (b.state !== 'suggested' && b.state !== 'committed') throw new Error('That block is not live.');
  var items = planItems_(null), id = blockIds_(b)[0], item = items.filter(function (i) { return i.id === id; })[0];
  if (item && b.state === 'committed' && mustCoverItems_(items, t).some(function (m) { return m.id === id; }) && committedFor_(id).length <= 1) throw new Error(item.name + ' ' + (item.retrieval ? 'is coming up soon' : 'is due tomorrow or sooner') + ', so it needs at least one block. Move it instead.');
  setBlock_(b, { state: 'cancelled' });
  return { ok: true };
};
G2_ACTIONS.planStart = function (role, p) {
  rohanOnly_(role);
  var b = findBlock_(p.blockId);
  if (b.state !== 'committed') throw new Error('Lock the block in first.');
  setBlock_(b, { startedAt: nowIso_() });
  return { ok: true };
};
/** Stage 1 tick off. The full Mission debrief arrives in stage 2. */
G2_ACTIONS.planDone = function (role, p) {
  rohanOnly_(role);
  var b = findBlock_(p.blockId);
  if (b.state !== 'committed' && b.state !== 'suggested' && b.state !== 'missed') throw new Error('That block is not live.');
  setBlock_(b, { state: 'done', startedAt: b.startedAt || nowIso_(), handled: 'TRUE' });
  if (p.taskDone) {
    blockIds_(b).forEach(function (id) {
      if (id.indexOf('hw:') === 0) upsertRow('Homework', { id: id.slice(3), status: 'done' }, 'id');
      else upsertRow('Agenda', { id: id, progressState: 'done', status: 'done' }, 'id');
    });
  }
  return { ok: true };
};
G2_ACTIONS.planRebook = function (role, p) {
  rohanOnly_(role);
  var b = findBlock_(p.blockId);
  if (b.state !== 'missed') throw new Error('That block did not miss.');
  var len = blockMins_(b), t = today_(), date = t, slot = null;
  var free = freeSlots_(date, { ignoreSuggested: true });
  if (/^\d{2}:\d{2}$/.test(p.start || '')) {
    var s = minutesOf_(p.start);
    if (free.some(function (f) { return s >= f.from && s + len <= f.to; })) slot = s;
    else throw new Error('That time is taken. Pick another.');
  } else {
    var f1 = free.filter(function (f) { return f.to - f.from >= len; })[0];
    if (!f1) { date = addDays_(t, 1); f1 = freeSlots_(date, { ignoreSuggested: true }).filter(function (f) { return f.to - f.from >= len; })[0]; }
    if (!f1) throw new Error('No free slot in the next two days. Open the plan and pick a time yourself.');
    slot = Math.ceil(f1.from / 5) * 5;
  }
  var nb = { blockId: 'b_' + uid_(), date: date, start: hm_(slot), end: hm_(slot + len), agendaIds: b.agendaIds, chunkLabel: b.chunkLabel, kind: b.kind, state: 'committed', intention: '', calEventId: '', createdBy: 'rohan', movedCount: '0', levelAtCreate: String(lvl_()), startedAt: '', handled: '', updatedAt: nowIso_() };
  nb.intention = intentionText_(nb.chunkLabel, nb.start, p.cue);
  upsertRow('Blocks', nb, 'blockId'); syncBlockEvent_(nb);
  upsertRow('Blocks', { blockId: b.blockId, handled: 'TRUE' }, 'blockId');
  return { ok: true, blockId: nb.blockId, date: date, start: nb.start };
};
G2_ACTIONS.planDismissMissed = function (role, p) { rohanOnly_(role); findBlock_(p.blockId); upsertRow('Blocks', { blockId: p.blockId, handled: 'TRUE' }, 'blockId'); return { ok: true }; };
/** After two misses on the same task, Echo asks one question and the plan adapts. */
G2_ACTIONS.planWhy = function (role, p) {
  rohanOnly_(role);
  var id = String(p.itemId || ''), r = String(p.reason || '');
  if (!id) throw new Error('Which task?');
  var patch = { tired: { chunkMax: 20 }, unclear: { hint: true }, no_time: { earlier: true }, forgot: { extraReminder: true } }[r];
  if (!patch) throw new Error('Pick one of the four.');
  setAdapt_(id, patch);
  return { ok: true, reply: { tired: 'Got it. I will make the next blocks shorter.', unclear: 'Got it. Try the hint ladder on that one, it goes one step at a time.', no_time: 'Got it. I will look for an earlier slot.', forgot: 'Got it. I will add an extra reminder.' }[r] };
};
G2_ACTIONS.planOffToday = function (role, p) {
  rohanOnly_(role);
  var r = OFF_REASONS[p.reason] ? p.reason : 'other', t = today_();
  upsertRow('Settings', { key: 'offToday', value: t }, 'key');
  upsertRow('Settings', { key: 'offReason', value: r }, 'key');
  getRows('Blocks', function (b) { return b.date === t && (b.state === 'suggested' || b.state === 'committed'); }).forEach(function (b) { setBlock_(b, { state: 'cancelled' }); });
  mail_('GamePlan: Rohan has marked today as off', '<p>Rohan has paused today\'s plan (' + esc_(OFF_REASONS[r]) + '). Nothing is wrong with the app. Tomorrow\'s plan is being rebuilt.</p>');
  proposePlan_([addDays_(t, 1)], false);
  return { ok: true };
};
G2_ACTIONS.planFill = function (role, p) { rohanOnly_(role); return { plan: proposePlan_([today_(), addDays_(today_(), 1)], true) }; };
G2_ACTIONS.planAck = function (role, p) { rohanOnly_(role); var a = getRows('Agenda', function (x) { return x.id === p.id; })[0]; if (a) upsertRow('Agenda', { id: a.id, dueChanged: 'FALSE' }, 'id'); return { ok: true }; };

/* ---------- Availability, edited by Rohan ---------- */
G2_ACTIONS.availabilityGet = function (role, p) { return { rows: getRows('Availability').map(function (r) { return { id: r.id, day: r.day, fromTime: r.fromTime, toTime: r.toTime, label: r.label, hard: p22Bool_(r.hard) }; }) }; };
G2_ACTIONS.availabilitySave = function (role, p) {
  rohanOnly_(role);
  var day = DAY3.indexOf(p.day) > -1 ? p.day : '', from = String(p.fromTime || ''), to = String(p.toTime || '');
  if (!day || !/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to) || minutesOf_(to) <= minutesOf_(from)) throw new Error('Pick a day and a start and end time.');
  var row = upsertRow('Availability', { id: p.id || ('av_' + uid_()), day: day, fromTime: from, toTime: to, label: clip_(p.label, 40).replace(/[<>]/g, '') || 'Busy', hard: p.hard === false ? 'FALSE' : 'TRUE' }, 'id');
  return { id: row.id };
};
G2_ACTIONS.availabilityRemove = function (role, p) { rohanOnly_(role); var r = getRows('Availability', function (x) { return x.id === p.id; })[0]; if (r) del_('Availability', r); return { ok: true }; };

/* ---------- parent actions ---------- */
G2_ACTIONS.planParent = function (role, p) {
  parentOnly_(role);
  var t = today_(), items = planItems_(null);
  var day = function (d) {
    var bl = getRows('Blocks', function (b) { return b.date === d && b.state !== 'cancelled' && b.state !== 'swapped'; }).sort(function (a, b) { return a.start.localeCompare(b.start); });
    return { date: d, blocks: bl.map(function (b) { return { label: b.chunkLabel, start: b.start, end: b.end, state: b.state, intention: b.intention }; }) };
  };
  return {
    level: lvl_(), levelName: LEVEL_NAMES[lvl_()], today: day(t), tomorrow: day(addDays_(t, 1)), locked: pathLocked_(t, items), off: setting_('offToday') === t,
    starters: ['Ask what he would change about tonight\'s plan.', 'Ask which block he is looking forward to least, and what would make it easier.']
  };
};
G2_ACTIONS.planLevelSet = function (role, p) {
  parentOnly_(role);
  var n = Math.round(Number(p.level));
  if (!(n >= 1 && n <= 3)) throw new Error('Pick OPERATOR, CO-PILOT or PILOT.');
  upsertRow('Settings', { key: 'operatorLevel', value: String(n) }, 'key');
  return { level: n, levelName: LEVEL_NAMES[n] };
};
