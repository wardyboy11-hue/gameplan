/**
 * Game Plan 2.0 data layer.
 * Six new tabs (Profile, Cards, XPLog, DayCheckIns, Quests, Settings) are declared in SCHEMA in Code.gs.
 * This file adds the helpers and a migration. It never removes or rewrites an existing tab.
 *
 * Locking: these helpers do not take a lock. Calls made through api() for a write action already hold
 * the script lock. Anything called from a trigger or the editor should wrap its writes in a lock.
 */

var DATA2_VERSION = 1;
var DATA2_TABS = ['Profile', 'Cards', 'XPLog', 'DayCheckIns', 'Quests', 'Settings', 'Homework', 'ThisWeek', 'Content', 'ContentLog', 'Reports', 'Accounts', 'ReaderCache', 'Milestones', 'SketchLog', 'Glitches', 'Agenda', 'Blocks', 'Timetable', 'Availability', 'KeyDates', 'ImportLog', 'Messages', 'Completions', 'Debriefs', 'Nudges'];

// Defaults are only written when the key is missing, so a value changed later is never overwritten.
var DATA2_DEFAULT_SETTINGS = {
  quietStart: '21:30',
  quietEnd: '07:00',
  dailyXpCap: '200',
  monthlyAiBudgetGBP: '10',
  // Prompt 22
  arborFolderId: '1bEudP9Eq5EwcTlCY9TdqOJwhGmbWevsY',
  arborStaleDays: '8',
  backlogDays: '14',
  operatorLevel: '1',
  weekAStart: '2026-11-02',
  weekAOverride: '',
  homeBy: '15:45',
  bedtime: '22:00',
  latestStudyEnd: '21:00',
  weekendStart: '10:00',
  commitDeadlineSchool: '17:30',
  commitDeadlineWeekend: '12:00',
  studyCalId: '',
  schoolCalId: '',
  offToday: '',
  offReason: '',
  prepBuffer: '30',
  shareAchievements: '0'
};

/* ---------- reading and writing ---------- */

/** Rows of a tab as objects. Each has _row, the sheet row number. Optional where(row) filter. */
function getRows(name, where) {
  if (!SCHEMA[name]) throw new Error('Unknown tab: ' + name);
  var all = rows_(name);
  return typeof where === 'function' ? all.filter(where) : all;
}

/**
 * Insert or update one row, matched on keyField (the first column unless you say otherwise).
 * An update only changes the fields you pass, so a partial object is safe.
 * Returns the saved row. Use addRow for logs, which have no unique key.
 */
function upsertRow(name, obj, keyField) {
  if (!SCHEMA[name]) throw new Error('Unknown tab: ' + name);
  var key = keyField || SCHEMA[name][0];
  if (SCHEMA[name].indexOf(key) < 0) throw new Error(name + ' has no column called ' + key);
  var id = obj[key] == null ? '' : String(obj[key]);
  if (id === '') throw new Error('upsertRow needs a value for ' + key);
  var hit = null, all = rows_(name);
  for (var i = 0; i < all.length; i++) { if (all[i][key] === id) { hit = all[i]; break; } }
  var row;
  if (hit) {
    row = hit;
    Object.keys(obj).forEach(function (k) { if (SCHEMA[name].indexOf(k) >= 0) row[k] = obj[k] == null ? '' : String(obj[k]); });
    if (SCHEMA[name].indexOf('updatedAt') >= 0 && obj.updatedAt == null) row.updatedAt = nowIso_();
    save_(name, row);
  } else {
    row = {};
    Object.keys(obj).forEach(function (k) { if (SCHEMA[name].indexOf(k) >= 0) row[k] = obj[k]; });
    if (SCHEMA[name].indexOf('updatedAt') >= 0 && row.updatedAt == null) row.updatedAt = nowIso_();
    append_(name, row);
    row = rows_(name).filter(function (r) { return r[key] === id; })[0] || row;
  }
  return row;
}

/** Append a row to a log style tab (XPLog, DayCheckIns). A missing ts is filled in with now. */
function addRow(name, obj) {
  if (!SCHEMA[name]) throw new Error('Unknown tab: ' + name);
  var row = {};
  Object.keys(obj).forEach(function (k) { if (SCHEMA[name].indexOf(k) >= 0) row[k] = obj[k]; });
  if (SCHEMA[name][0] === 'ts' && !row.ts) row.ts = nowIso_();
  if (SCHEMA[name][0] === 'id' && !row.id) row.id = uid_();
  append_(name, row);
  return row;
}

/** One setting as a number when it looks like one, otherwise text. Falls back to the default. */
function getSetting(key) {
  var hit = getRows('Settings', function (r) { return r.key === key; })[0];
  var v = hit && hit.value !== '' ? hit.value : DATA2_DEFAULT_SETTINGS[key];
  if (v == null) throw new Error('No setting called ' + key);
  return /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : String(v);
}

/* ---------- migration: safe to run again and again ---------- */

function migrateData2() {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(props_().getProperty('SSID'));
    var report = [];
    DATA2_TABS.forEach(function (name) {
      var want = SCHEMA[name];
      var clash = ss.getSheets().filter(function (s) { return s.getName().toLowerCase() === name.toLowerCase() && s.getName() !== name; })[0];
      if (clash) throw new Error('A tab called "' + clash.getName() + '" already exists and would clash with "' + name + '". Nothing was changed.');
      var sh = ss.getSheetByName(name);
      if (!sh) { sheet_(name); report.push(name + ': created'); return; }
      var have = sh.getLastColumn() > 0 ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
      while (have.length && have[have.length - 1] === '') have.pop();
      if (have.length === 0) {
        sh.getRange(1, 1, 1, want.length).setValues([want]).setFontWeight('bold');
        sh.setFrozenRows(1);
        report.push(name + ': header written');
      } else if (have.join('|') === want.join('|')) {
        report.push(name + ': already fine');
      } else if (have.length < want.length && have.join('|') === want.slice(0, have.length).join('|')) {
        sh.getRange(1, have.length + 1, 1, want.length - have.length).setValues([want.slice(have.length)]).setFontWeight('bold');
        report.push(name + ': added columns ' + want.slice(have.length).join(', '));
      } else {
        throw new Error('Tab "' + name + '" has different column headings from the plan, so it was left alone. Rename it or move its data, then run this again.');
      }
    });
    Object.keys(DATA2_DEFAULT_SETTINGS).forEach(function (k) {
      if (!getRows('Settings', function (r) { return r.key === k; }).length) {
        append_('Settings', { key: k, value: DATA2_DEFAULT_SETTINGS[k], updatedAt: nowIso_() });
        report.push('Settings: added ' + k);
      }
    });
    props_().setProperty('DATA2_VERSION', String(DATA2_VERSION));
    log_('system', 'migrateData2', report.join('; '));
    return report.join('\n');
  } finally {
    lock.releaseLock();
  }
}
