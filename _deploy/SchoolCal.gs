/* SchoolCal.gs: school dates, Week A and B, holiday mode and the "GamePlan School" Google Calendar (Prompt 22, stage 1).
   Everything here is separate from the study calendar that Planner.gs writes. */
var G2_ACTIONS = (typeof G2_ACTIONS === 'undefined') ? {} : G2_ACTIONS;

/* Seed. Verified 30 Oct 2026 from the school holiday dates page, the Wigan school portal and the Mosaic INSET letter.
   Rows marked TBC are placeholders: parents fill them in, then tick confirmed. Only confirmed rows reach the calendar. */
var KEYDATES_SEED = [
  ['kd_inset_0901', 'inset', 'INSET day', '2026-09-01', '2026-09-02', '', '', 'school-web', 'TRUE', ''],
  ['kd_inset_1002', 'inset', 'INSET day', '2026-10-02', '', '', '', 'school-web', 'TRUE', ''],
  ['kd_ht_oct26', 'holiday', 'October half term', '2026-10-26', '2026-10-30', '', '', 'school-web', 'TRUE', ''],
  ['kd_return_nov', 'term', 'Back to school (Autumn 2)', '2026-11-02', '', '', '', 'school-web', 'TRUE', ''],
  ['kd_report1', 'report', 'Interim report (Grade Trawl 1)', '2026-11-16', '', '', '', 'manual', 'TRUE', ''],
  ['kd_pe1', 'parents_evening', "Parents' evening", '2026-11-19', '', '15:45', '19:00', 'manual', 'TRUE', 'Times from the school slides. Confirm the time.'],
  ['kd_close_dec', 'closure', 'School closes at 1pm', '2026-12-18', '', '13:00', '', 'school-web', 'TRUE', 'Early close for Christmas.'],
  ['kd_xmas', 'holiday', 'Christmas holiday', '2026-12-21', '2027-01-04', '', '', 'school-web', 'TRUE', ''],
  ['kd_inset_0105', 'inset', 'INSET day', '2027-01-05', '', '', '', 'school-web', 'TRUE', ''],
  ['kd_return_jan', 'term', 'Students back (Spring 1)', '2027-01-06', '', '', '', 'school-web', 'TRUE', ''],
  ['kd_close_feb', 'term', 'Spring 1 ends (closes 15:05)', '2027-02-12', '', '15:05', '', 'school-web', 'TRUE', ''],
  ['kd_ht_feb', 'holiday', 'February half term', '2027-02-15', '2027-02-19', '', '', 'school-web', 'TRUE', ''],
  ['kd_inset_0222', 'inset', 'INSET day (Trust)', '2027-02-22', '', '', '', 'manual', 'TRUE', 'From the Mosaic INSET letter. The school web page shows 22 Feb as the return date, so students may be back on 23 Feb. Check.'],
  ['kd_close_mar', 'term', 'Spring 2 ends (closes 15:05)', '2027-03-24', '', '15:05', '', 'school-web', 'TRUE', ''],
  ['kd_easter', 'holiday', 'Easter holiday', '2027-03-25', '2027-04-09', '', '', 'school-web', 'TRUE', ''],
  ['kd_return_apr', 'term', 'Back to school (Summer 1)', '2027-04-12', '', '', '', 'school-web', 'TRUE', ''],
  ['kd_bank_may', 'bank_holiday', 'Bank holiday', '2027-05-03', '', '', '', 'school-web', 'TRUE', ''],
  ['kd_lit1', 'exam', 'English Literature Paper 1 (Macbeth, poetry)', '2027-05-12', '', '09:15', '11:15', 'exam-board', 'TRUE', 'Eduqas. 2 hours. Check the start time with the school.'],
  ['kd_lit2', 'exam', 'English Literature Paper 2 (Christmas Carol, Inspector Calls)', '2027-05-19', '', '09:15', '11:45', 'exam-board', 'TRUE', 'Eduqas. 2 hours 30 minutes. Check the start time with the school.'],
  ['kd_close_may', 'term', 'Summer 1 ends (closes 15:05)', '2027-05-28', '', '15:05', '', 'school-web', 'TRUE', ''],
  ['kd_ht_may', 'holiday', 'May half term', '2027-05-31', '2027-06-04', '', '', 'school-web', 'TRUE', ''],
  ['kd_return_jun', 'term', 'Back to school (Summer 2)', '2027-06-07', '', '', '', 'school-web', 'TRUE', ''],
  ['kd_inset_0705', 'inset', 'INSET day (Trust)', '2027-07-05', '', '', '', 'manual', 'TRUE', 'From the Mosaic INSET letter.'],
  ['kd_close_jul', 'closure', 'School closes at 1pm (end of year)', '2027-07-21', '', '13:00', '', 'school-web', 'TRUE', ''],
  ['kd_summer', 'holiday', 'TBC Summer holiday', '2027-07-22', '2027-08-31', '', '', 'manual', 'FALSE', 'Placeholder. Confirm and tick.'],
  ['kd_tbc_mocks', 'mock', 'TBC Year 10 mock window', '', '', '', '', 'manual', 'FALSE', 'Fill in when the school confirms.'],
  ['kd_tbc_papers', 'exam', 'TBC other 2027 GCSE papers', '', '', '', '', 'manual', 'FALSE', 'Fill in when the school confirms.'],
  ['kd_tbc_inset', 'inset', 'TBC further INSET days 2027', '', '', '', '', 'manual', 'FALSE', 'Fill in when the school confirms.']
];

/** Adds any missing seed rows by keyId. Never changes a row that is already there. */
function seedKeyDates_() {
  var have = {}; getRows('KeyDates').forEach(function (r) { have[r.keyId] = 1; });
  var n = 0;
  KEYDATES_SEED.forEach(function (s) {
    if (have[s[0]]) return;
    upsertRow('KeyDates', { keyId: s[0], type: s[1], title: s[2], startDate: s[3], endDate: s[4], startTime: s[5], endTime: s[6], location: '', source: s[7], audience: 'both', confirmed: s[8], notes: s[9], calEventId: '', calHash: '' }, 'keyId');
    n++;
  });
  return n;
}

/* ---------- Timetable and Availability seeds ---------- */
var PERIODS = [['Reg', '08:50', '09:05'], ['P1', '09:05', '10:05'], ['P2', '10:05', '11:05'], ['P3', '11:20', '12:20'], ['P4', '13:05', '14:05'], ['P5', '14:05', '15:05']];
var DAYS_MF = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
/** Period times only. The subject for each lesson is left blank for parents to fill from Arbor. */
function seedTimetable_() {
  if (getRows('Timetable').length) return 0;
  var n = 0;
  ['A', 'B'].forEach(function (wk) {
    DAYS_MF.forEach(function (d) {
      PERIODS.forEach(function (p) {
        if (d === 'Fri' && p[0] === 'P5') return; // Friday P4 and P5 are one block, 13:05 to 15:05
        var end = (d === 'Fri' && p[0] === 'P4') ? '15:05' : p[2];
        append_('Timetable', { weekAB: wk, day: d, period: p[0], start: p[1], end: end, subject: '' }); n++;
      });
    });
  });
  return n;
}
/** Football training Tue and Wed 8 to 9pm, matches Sat and Sun morning and early afternoon. Rohan edits these. */
function seedAvailability_() {
  if (getRows('Availability').length) return 0;
  [['Tue', '20:00', '21:00', 'Football training', 'TRUE'], ['Wed', '20:00', '21:00', 'Football training', 'TRUE'],
   ['Sat', '09:00', '14:00', 'Match', 'TRUE'], ['Sun', '09:00', '14:00', 'Match', 'TRUE']].forEach(function (a) {
    addRow('Availability', { day: a[0], fromTime: a[1], toTime: a[2], label: a[3], hard: a[4] });
  });
  return 4;
}
function seedPlanData() { var a = seedKeyDates_(), b = seedTimetable_(), c = seedAvailability_(); migrateData2(); return 'KeyDates +' + a + ', Timetable +' + b + ', Availability +' + c; }

/* ---------- day information ---------- */
function dayName_(s) { return DAY3[dowOf_(s)]; }
function keyDates_() { return getRows('KeyDates', function (r) { return r.startDate && p22Bool_(r.confirmed); }); }
function inKeyRange_(k, s) { return s >= k.startDate && s <= (k.endDate || k.startDate); }

/** Whole-day closures: holiday ranges, INSET days, bank holidays, and closures with no start time. */
function closedAllDay_(s, kds) {
  return (kds || keyDates_()).some(function (k) {
    return inKeyRange_(k, s) && (k.type === 'holiday' || k.type === 'inset' || k.type === 'bank_holiday' || (k.type === 'closure' && !k.startTime));
  });
}
function holidayWeek_(mon, kds) {
  for (var i = 0; i < 5; i++) {
    var d = addDays_(mon, i);
    var inHoliday = kds.some(function (k) { return k.type === 'holiday' && inKeyRange_(k, d); });
    if (!inHoliday) return false;
  }
  return true;
}
/** 'A', 'B', or '' for a holiday week. The cycle carries on after a holiday. weekAOverride (a Monday) wins over weekAStart. */
function weekLabel_(dateStr) {
  var kds = keyDates_(), base = mondayOf_(String(getSetting('weekAOverride') || getSetting('weekAStart'))), target = mondayOf_(dateStr);
  if (holidayWeek_(target, kds)) return '';
  var n = 0, cur;
  if (target >= base) { for (cur = base; cur < target; cur = addDays_(cur, 7)) { if (!holidayWeek_(cur, kds)) n++; } }
  else { for (cur = target; cur < base; cur = addDays_(cur, 7)) { if (!holidayWeek_(cur, kds)) n++; } }
  return n % 2 === 0 ? 'A' : 'B';
}
/** Everything the planner needs to know about one date. */
function dayInfo_(s) {
  var kds = keyDates_(), dow = dowOf_(s), weekend = dow === 0 || dow === 6;
  var closed = closedAllDay_(s, kds);
  var early = '';
  kds.forEach(function (k) { if (k.type === 'closure' && k.startTime && inKeyRange_(k, s)) early = k.startTime; });
  var inset = kds.some(function (k) { return k.type === 'inset' && inKeyRange_(k, s); });
  return {
    date: s, weekend: weekend, holidayMode: !weekend && closed, inset: inset, earlyClose: early,
    schoolDay: !weekend && !closed, week: weekend ? '' : weekLabel_(s)
  };
}

/* ---------- the calendar ---------- */
function retry_(fn) {
  var last;
  for (var i = 0; i < 3; i++) { try { return fn(); } catch (e) { last = e; Utilities.sleep(400 * (i + 1)); } }
  throw last;
}
function namedCal_(settingKey, name) {
  var id = String(getSetting(settingKey));
  if (id) { try { var c = CalendarApp.getCalendarById(id); if (c) return c; } catch (e) {} }
  var cal = retry_(function () { return CalendarApp.createCalendar(name); });
  try { cal.setTimeZone('Europe/London'); } catch (e) {}
  upsertRow('Settings', { key: settingKey, value: cal.getId() }, 'key');
  return cal;
}
function schoolCal_() { return namedCal_('schoolCalId', 'GamePlan School'); }

function colourFor_(type) {
  var C = CalendarApp.EventColor;
  return { homework: C.BLUE, test: C.ORANGE, mock: C.RED, exam: C.RED, holiday: C.GREEN, inset: C.GREEN, bank_holiday: C.GREEN, closure: C.GREEN, term: C.GREEN, event: C.MAUVE, trip: C.MAUVE, report: C.GRAY, parents_evening: C.GRAY }[type] || C.GRAY;
}
function titleFor_(type, subject, title) {
  var s = subject ? subject + ' ' : '';
  if (type === 'homework') return '📘 Due: ' + s + title;
  if (type === 'test') return '📝 Test: ' + s + title;
  if (type === 'mock') return '🧪 Mock: ' + s + title;
  if (type === 'exam') return '🎓 ' + title;
  if (type === 'holiday' || type === 'inset' || type === 'bank_holiday') return 'School closed: ' + title;
  return title;
}
/** Reminder minutes before the event start. 18:00 the day before (and 7 days before for tests and exams), plus 08:00 on exam morning. */
function reminderMinutes_(type, startMin) {
  var at18 = function (n) { return n * 1440 + startMin - 1080; };
  if (type === 'homework') return [at18(1)];
  if (type === 'test' || type === 'mock' || type === 'exam') { var out = [at18(7), at18(1)]; if (startMin > 480) out.push(startMin - 480); return out; }
  if (type === 'parents_evening' || type === 'report' || type === 'event' || type === 'trip') return [at18(1)];
  return [];
}
function fireAllowed_(startDate, startMin, minutesBefore, examMorning) {
  var fire = new Date(parseD_(startDate).getTime() + (startMin - minutesBefore) * 60000);
  var dow = Number(Utilities.formatDate(fire, tz_(), 'u')) % 7, cur = Number(Utilities.formatDate(fire, tz_(), 'H')) * 60 + Number(Utilities.formatDate(fire, tz_(), 'm'));
  if (isQuiet_(fire)) return false;
  if (!examMorning && dow >= 1 && dow <= 5 && inRanges_(cur, nudgeSetting_('schoolHours'))) return false;
  return true;
}

/** Build the list of events that should exist. */
function desiredEvents_() {
  var out = [];
  keyDates_().forEach(function (k) {
    var type = k.type;
    var startMin = k.startTime ? minutesOf_(k.startTime) : 0;
    // closures with a time and plain term markers are not "closed all day" events
    var allDay = !k.startTime || type === 'holiday' || type === 'inset' || type === 'bank_holiday';
    if (type === 'term' && k.startTime) allDay = true;
    if (type === 'closure' && k.startTime) allDay = true;
    out.push({ ref: 'KeyDates', id: k.keyId, row: k, type: type, title: titleFor_(type, '', k.title), start: k.startDate, end: k.endDate || k.startDate, allDay: allDay, startTime: allDay ? '' : k.startTime, endTime: k.endTime, location: k.location, startMin: allDay ? 0 : startMin });
  });
  getRows('Agenda', function (a) {
    return a.dueDate && a.audience !== 'parents' && ['homework', 'test', 'mock', 'event'].indexOf(a.type) > -1 &&
      a.status !== 'done' && a.status !== 'dismissed' && a.backlog !== 'check' && a.backlog !== 'ignored' && a.arborMissing !== 'TRUE';
  }).forEach(function (a) {
    var timed = a.dueTime && a.type !== 'homework';
    out.push({ ref: 'Agenda', id: a.id, row: a, type: a.type, title: titleFor_(a.type, a.subject, a.title), start: a.dueDate, end: a.dueDate, allDay: !timed, startTime: timed ? a.dueTime : '', endTime: '', location: a.location, startMin: timed ? minutesOf_(a.dueTime) : 0 });
  });
  return out;
}
function evHash_(d) { return hash_([d.title, d.start, d.end, d.startTime, d.endTime, d.location, d.type].join('|')); }

function calIdCol_(ref) { return ref === 'Agenda' ? 'schoolCalEventId' : 'calEventId'; }
function calHashCol_(ref) { return ref === 'Agenda' ? 'schoolCalHash' : 'calHash'; }
function keyCol_(ref) { return ref === 'Agenda' ? 'id' : 'keyId'; }

function createEvent_(cal, d) {
  var ev;
  if (d.allDay) {
    var endEx = parseD_(addDays_(d.end, 1));
    ev = d.start === d.end ? cal.createAllDayEvent(d.title, parseD_(d.start), { description: d.row.notes || '' }) : cal.createAllDayEvent(d.title, parseD_(d.start), endEx, { description: d.row.notes || '' });
  } else {
    var s = new Date(d.start + 'T' + d.startTime + ':00'), e = new Date(d.start + 'T' + (d.endTime || hm_(d.startMin + 60)) + ':00');
    ev = cal.createEvent(d.title, s, e, { location: d.location || '', description: d.row.notes || '' });
  }
  ev.setColor(colourFor_(d.type));
  ev.removeAllReminders();
  reminderMinutes_(d.type, d.startMin).forEach(function (m) {
    var examMorning = (d.type === 'test' || d.type === 'mock' || d.type === 'exam') && d.startMin > 480 && m === d.startMin - 480;
    if (fireAllowed_(d.start, d.startMin, m, examMorning)) ev.addPopupReminder(m);
  });
  return ev;
}

/** Nightly 21:00 and after any Agenda or KeyDates change. Safe to run again and again. */
function syncSchoolCalendar() {
  var cal = schoolCal_(), want = desiredEvents_(), stats = { created: 0, updated: 0, removed: 0, cancelled: 0 }, wantKeys = {};
  want.forEach(function (d) {
    wantKeys[d.ref + ':' + d.id] = 1;
    var h = evHash_(d), idCol = calIdCol_(d.ref), hCol = calHashCol_(d.ref), have = d.row[idCol], same = d.row[hCol] === h;
    if (have && same) return;
    if (have) { try { var old = cal.getEventById(have); if (old) old.deleteEvent(); } catch (e) {} }
    var ev = retry_(function () { return createEvent_(cal, d); });
    var patch = {}; patch[keyCol_(d.ref)] = d.id; patch[idCol] = ev.getId(); patch[hCol] = h;
    upsertRow(d.ref, patch, keyCol_(d.ref));
    if (have) stats.updated++; else stats.created++;
  });
  // events that should no longer exist
  ['KeyDates', 'Agenda'].forEach(function (ref) {
    var idCol = calIdCol_(ref), hCol = calHashCol_(ref);
    getRows(ref, function (r) { return r[idCol]; }).forEach(function (r) {
      if (wantKeys[ref + ':' + r[keyCol_(ref)]]) return;
      var patch = {}; patch[keyCol_(ref)] = r[keyCol_(ref)];
      var done = ref === 'Agenda' && (r.status === 'done');
      var marker = String(r[hCol]);
      try {
        var ev = cal.getEventById(r[idCol]);
        if (!ev || done) { if (ev) ev.deleteEvent(); patch[idCol] = ''; patch[hCol] = ''; stats.removed++; }
        else if (marker.indexOf('X:') === 0) {
          if (daysBetween_(marker.slice(2), today_()) >= 7) { ev.deleteEvent(); patch[idCol] = ''; patch[hCol] = ''; stats.removed++; }
        } else { ev.setTitle('CANCELLED · ' + ev.getTitle()); patch[hCol] = 'X:' + today_(); stats.cancelled++; }
      } catch (e) { log_('system', 'calfail', 'school cal: ' + String(e).slice(0, 100)); }
      upsertRow(ref, patch, keyCol_(ref));
    });
  });
  upsertRow('Settings', { key: 'schoolCalSyncedAt', value: nowIso_() }, 'key');
  return stats;
}

/* ---------- parent actions ---------- */
G2_ACTIONS.keyDatesList = function (role, p) {
  parentOnly_(role);
  seedKeyDates_();
  return { dates: getRows('KeyDates').map(function (r) { return { keyId: r.keyId, type: r.type, title: r.title, startDate: r.startDate, endDate: r.endDate, startTime: r.startTime, confirmed: p22Bool_(r.confirmed), notes: r.notes }; }).sort(function (a, b) { return String(a.startDate || '9999').localeCompare(String(b.startDate || '9999')); }) };
};
G2_ACTIONS.keyDateSave = function (role, p) {
  parentOnly_(role);
  var k = getRows('KeyDates', function (r) { return r.keyId === p.keyId; })[0];
  if (!k) throw new Error('Could not find that date.');
  var patch = { keyId: k.keyId };
  if (validDate_(p.startDate)) patch.startDate = p.startDate;
  if (p.endDate === '' || validDate_(p.endDate)) patch.endDate = p.endDate;
  if (validTime_(p.startTime)) patch.startTime = p.startTime;
  if (p.title) patch.title = clip_(p.title, 120).replace(/[<>]/g, '');
  if (p.confirmed != null) patch.confirmed = p.confirmed ? 'TRUE' : 'FALSE';
  upsertRow('KeyDates', patch, 'keyId');
  try { syncSchoolCalendar(); } catch (e) { log_('system', 'calfail', String(e).slice(0, 100)); }
  return { ok: true };
};
G2_ACTIONS.syncSchoolNow = function (role, p) { parentOnly_(role); return syncSchoolCalendar(); };

/* ---------- gym: Tuesday and Thursday straight from school (stage 2) ---------- */
/** Soft, so the planner works around it but does not add a prep buffer. Real finish time to be confirmed with Rohan. Safe to run again. */
function seedGym_() {
  if (props_().getProperty('gym_seeded')) return 0;
  props_().setProperty('gym_seeded', '1');
  if (getRows('Availability', function (r) { return /gym/i.test(r.label); }).length) return 0;
  ['Tue', 'Thu'].forEach(function (d) { addRow('Availability', { id: 'av_' + uid_(), day: d, fromTime: '15:15', toTime: '17:30', label: 'Gym', hard: 'FALSE' }); });
  return 2;
}

/* ---------- the in app calendar ---------- */
/** One month of key dates, due dates and locked in blocks. Parent only items stay hidden from Rohan. */
G2_ACTIONS.monthGet = function (role, p) {
  var m = /^\d{4}-\d{2}$/.test(p && p.month || '') ? p.month : today_().slice(0, 7);
  var first = m + '-01', days = [], d = first;
  while (d.slice(0, 7) === m) { days.push(d); d = addDays_(d, 1); }
  var last = days[days.length - 1], rohan = role === 'rohan';
  var kds = getRows('KeyDates', function (k) { return k.startDate && k.startDate <= last && (k.endDate || k.startDate) >= first && (!rohan || String(k.audience) !== 'parents'); });
  var agenda = getRows('Agenda', function (a) { return a.dueDate >= first && a.dueDate <= last && ['homework', 'test', 'mock', 'event'].indexOf(a.type) > -1 && a.status !== 'dismissed' && a.arborMissing !== 'TRUE' && (!rohan || a.audience !== 'parents'); });
  var blocks = getRows('Blocks', function (b) { return b.date >= first && b.date <= last && (b.state === 'committed' || b.state === 'done'); });
  return {
    month: m, today: today_(),
    days: days.map(function (x) {
      var info = dayInfo_(x), ev = [];
      kds.forEach(function (k) { if (inKeyRange_(k, x)) ev.push({ kind: k.type, title: clip_(k.title, 60), time: k.startTime || '', tbc: !p22Bool_(k.confirmed) }); });
      agenda.forEach(function (a) { if (a.dueDate === x) ev.push({ kind: a.type === 'homework' ? 'due' : a.type, title: clip_((a.subject ? a.subject + ': ' : '') + a.title, 70), time: a.dueTime || '', done: a.progressState === 'done' || a.status === 'done' }); });
      blocks.forEach(function (b) { if (b.date === x) ev.push({ kind: 'block', title: clip_(b.chunkLabel, 60), time: b.start }); });
      return { date: x, dow: dowOf_(x), week: info.week || '', closed: !info.weekend && !info.schoolDay, events: ev };
    })
  };
};
