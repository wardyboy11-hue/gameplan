/* =====================================================================
   Alerts.gs  (Prompt 22, section 6)
   Rohan hears first. Parents only hear after his own deadline has passed.
   Shared budget for Rohan: no more than 4 nudges a day, none in quiet or
   school hours. Calendar popups are separate and not counted.
   ===================================================================== */

var NUDGE_MAX_PER_DAY = 4;

/** True while he is in lessons: school days, before homeBy. */
function inSchoolHours_(now) {
  var d = now || p22Now_(), t = fmtD_(d), info = dayInfo_(t);
  if (!info.schoolDay) return false;
  var cur = Number(Utilities.formatDate(d, tz_(), 'H')) * 60 + Number(Utilities.formatDate(d, tz_(), 'm'));
  return cur >= 8 * 60 && cur < minutesOf_(setting_('homeBy'));
}

function nudgesToday_() { var t = today_(); return getRows('Nudges', function (n) { return String(n.at).slice(0, 10) === t; }); }

/** Adds one in-app transmission for Rohan. Returns false when the budget, quiet hours or school hours say no. */
function nudgeRohan_(kind, text, opts) {
  opts = opts || {};
  var now = opts.now || p22Now_();
  if (!opts.force) {
    if (isQuiet_(now) || inSchoolHours_(now)) return false;
    var today = nudgesToday_();
    if (today.length >= NUDGE_MAX_PER_DAY) return false;
    if (kind === 'headsup' && today.filter(function (n) { return n.kind === 'headsup'; }).length >= 2) return false;
  }
  var key = opts.key ? opts.key + '@' + fmtD_(now) : '';
  if (key && getRows('Nudges', function (n) { return n.dedupe === key; }).length) return false;
  addRow('Nudges', { nudgeId: 'n_' + uid_(), at: Utilities.formatDate(now, tz_(), "yyyy-MM-dd'T'HH:mm:ss"), kind: kind, text: clip_(text, 200), seen: '', dedupe: key });
  return true;
}

G2_ACTIONS.nudgesGet = function (role, p) {
  rohanOnly_(role);
  var from = addDays_(today_(), -1);
  var list = getRows('Nudges', function (n) { return !n.seen && String(n.at).slice(0, 10) >= from; }).slice(-4).map(function (n) { return { id: n.nudgeId, kind: n.kind, text: n.text, at: n.at }; });
  return { nudges: list };
};
G2_ACTIONS.nudgeSeen = function (role, p) { rohanOnly_(role); upsertRow('Nudges', { nudgeId: p.id, seen: 'TRUE' }, 'nudgeId'); return { ok: true }; };

/** Runs every 15 minutes. Rohan first, parents only once his own deadline has passed. */
function alertsTick() {
  try { seedGym_(); } catch (e) { log_('system', 'gymseed', String(e).slice(0, 80)); }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 'busy';
  var out = [];
  try {
    MEMO_ = {};
    var now = p22Now_(), t = fmtD_(now), cur = nowMin_(), info = dayInfo_(t);
    var dl = commitDeadlineMin_(t);
    var off = setting_('offToday') === t;
    if (!info.holidayMode && !off && dl !== null) {
      var items = planItems_(null), locked = pathLocked_(t, items), open = items.length > 0;
      // commit reminder: 16:30 on school days, an hour before the weekend deadline otherwise
      var home = gymArrival_(t), remindAt = info.weekend ? dl - 60 : (home !== null ? home + 5 : 16 * 60 + 30);
      if (open && !locked && cur >= remindAt && cur < dl) {
        var n = getRows('Blocks', function (b) { return (b.date === t || b.date === addDays_(t, 1)) && b.state === 'suggested'; }).length;
        if (nudgeRohan_('commit', (n || 2) + ' blocks to place. 60 seconds.', { key: 'commit' })) out.push('commit nudge');
      }
      // escalation: his deadline plus 30 minutes has gone by
      if (open && !locked && cur >= dl + 30) {
        if (parentAlert_('nocommit_' + t, 'Rohan has not locked in tonight\'s plan', 'His deadline was ' + hm_(dl) + '. The plan is still suggested, not committed. A friendly "want a hand with tonight?" is likely to land better than a reminder.')) out.push('parent: not committed');
      }
    }
    // overdue items and tests close with no prep: parents hear once a day
    var dig = digestFacts_();
    if (dig.overdue.length && cur >= 17 * 60) { if (parentAlert_('overdue_' + t, dig.overdue.length + ' task' + (dig.overdue.length > 1 ? 's' : '') + ' past due', dig.overdue.slice(0, 5).join('; ') + '. Ask which one he wants to start with.')) out.push('parent: overdue'); }
    dig.testsNoPrep.forEach(function (x) { if (parentAlert_('noprep_' + x.id, 'A test is close and nothing is booked', x.label + ' is in ' + x.days + ' days with no revision blocks locked in. Ask what would make a start feel easier.')) out.push('parent: no prep'); });
    // feed stale is handled in Arbor.gs. Watcher health is checked here.
    var wl = Number(props_().getProperty('watcher_last') || 0);
    if (wl && (Date.now() - wl) > 36 * 3600000) parentAlert_('watcherstale', 'The school message watcher has gone quiet', 'No check has run for over a day. School emails may not be reaching the app.');
    // the parent digest
    if (cur >= 19 * 60 + 30 && cur < 20 * 60 + 30 && props_().getProperty('digest_sent') !== t) {
      if (parentDigest_()) out.push('digest');
      props_().setProperty('digest_sent', t);
    }
    // held school messages are released after quiet hours
    if (typeof releaseHeld_ === 'function') { var r = releaseHeld_(); if (r) out.push('released ' + r); }
  } finally { lock.releaseLock(); }
  return out.join(', ') || 'nothing to do';
}

/** What is worth saying today. Empty lists mean no digest. */
function digestFacts_() {
  var t = today_(), items = planItems_(null);
  var overdue = getRows('Agenda', function (a) { return a.overdue === 'TRUE' && a.status !== 'done' && a.progressState !== 'done' && a.status !== 'dismissed' && a.backlog !== 'ignored' && a.arborMissing !== 'TRUE'; }).map(function (a) { return clip_(a.title, 60); });
  var tests = getRows('Agenda', function (a) { return (a.type === 'test' || a.type === 'mock') && a.status !== 'done' && a.dueDate && daysBetween_(t, a.dueDate) >= 0 && daysBetween_(t, a.dueDate) <= 14; });
  var testsNoPrep = [];
  tests.forEach(function (a) {
    var d = daysBetween_(t, a.dueDate);
    if (d > 3) return;
    var has = getRows('Blocks', function (b) { return (b.state === 'committed' || b.state === 'done') && blockIds_(b).indexOf(a.id) > -1; }).length;
    if (!has) testsNoPrep.push({ id: a.id, label: clip_(a.title, 60), days: d });
  });
  return { overdue: overdue, tests: tests, testsNoPrep: testsNoPrep, items: items };
}

/** Daily 19:30 email to both parents, only when there is something worth saying. */
function parentDigest_() {
  var t = today_(), f = digestFacts_(), lines = [];
  var comps = completionsView_(0);
  var blocks = getRows('Blocks', function (b) { return b.date === t && b.state !== 'cancelled' && b.state !== 'swapped'; });
  var msgs = getRows('Messages', function (m) { return String(m.receivedAt).slice(0, 10) === t && m.audience !== 'none'; });
  var newTrans = msgs.length;
  if (!comps.length && !f.overdue.length && !f.tests.length && !newTrans) return false;
  var committed = blocks.filter(function (b) { return b.state === 'committed' || b.state === 'done'; }).length, suggested = blocks.filter(function (b) { return b.state === 'suggested'; }).length;
  var h = '<p><b>Today\'s plan:</b> ' + committed + ' locked in' + (suggested ? ', ' + suggested + ' still suggested' : '') + '.</p>';
  if (comps.length) {
    h += '<p><b>Check ins:</b></p><ul>' + comps.map(function (c) {
      return '<li>' + esc_(c.title) + ': ' + esc_(String(c.outcome).replace('_', ' ')) + (c.confidence ? ', confidence ' + esc_(c.confidence) + ' of 5' : '') + (c.q2Correct ? ', quiz question ' + (c.q2Correct === 'yes' ? 'right' : 'not quite') : '') + (c.sparxPct != null ? ', Sparx ' + c.sparxPct + '%' : '') + '</li>';
    }).join('') + '</ul>';
  }
  if (f.overdue.length) h += '<p><b>Past due:</b> ' + f.overdue.map(esc_).join('; ') + '</p>';
  if (f.tests.length) h += '<p><b>Tests in the next 14 days:</b> ' + f.tests.map(function (a) { return esc_(clip_(a.title, 50)) + ' (' + esc_(a.dueDate) + ')'; }).join('; ') + '</p>';
  if (newTrans) h += '<p><b>New school messages:</b> ' + newTrans + ' (see the Messages tab).</p>';
  h += '<p><i>Conversation starter: ask what he would change about tomorrow\'s plan.</i></p>';
  mail_('GamePlan: today in brief', h);
  return true;
}

/** Health for the parent view. */
function healthView_() {
  var imp = getRows('ImportLog').slice(-1)[0] || null;
  var wl = Number(props_().getProperty('watcher_last') || 0);
  var triggers = [];
  try { triggers = ScriptApp.getProjectTriggers().map(function (x) { return x.getHandlerFunction(); }); } catch (e) {}
  return {
    arbor: imp ? { runAt: imp.runAt, rows: imp.rows, added: imp.added, errors: imp.errors } : null,
    watcherLast: wl ? Utilities.formatDate(new Date(wl), tz_(), "yyyy-MM-dd'T'HH:mm") : '',
    watcherCount: getRows('Messages').length,
    triggersOk: ['alertsTick', 'watchSchoolMail', 'importArborCsv', 'proposePlanDaily'].filter(function (n) { return triggers.indexOf(n) < 0; }),
    studyCal: !!setting_('studyCalId'), schoolCal: !!setting_('schoolCalId'),
    estimate: estimateReview_()
  };
}

/** Everything the parent screens need in one call. */
G2_ACTIONS.parentStage2 = function (role, p) {
  parentOnly_(role);
  return {
    completions: completionsView_(7),
    messages: getRows('Messages').slice(-15).reverse().map(function (m) { return { id: m.messageId, at: m.receivedAt, from: m.from, subject: m.subject, category: m.category, urgency: m.urgency, audience: m.audience, summary: m.parentSummary, ackBy: m.ackBy }; }),
    health: healthView_()
  };
};
G2_ACTIONS.messageAck = function (role, p) { parentOnly_(role); upsertRow('Messages', { messageId: p.id, ackBy: String(p.by || '').toLowerCase() === 'mum' ? 'Mum' : 'Dad' }, 'messageId'); return { ok: true }; };

/** Run once from the editor, or let the installer call it. Safe to run again. */
function installStage2Triggers() {
  try { seedGym_(); } catch (e) {}
  var ours = ['alertsTick', 'watchSchoolMail'];
  ScriptApp.getProjectTriggers().forEach(function (t) { if (ours.indexOf(t.getHandlerFunction()) > -1) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('alertsTick').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('watchSchoolMail').timeBased().everyMinutes(15).create();
  return 'Stage 2 triggers installed: alerts every 15 minutes, school mail watcher every 15 minutes.';
}
