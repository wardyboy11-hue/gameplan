/* =====================================================================
   Debrief.gs  (Prompt 22, section 3)
   Tapping Done opens a 30 second Mission debrief about that one task.
   Claude writes the questions once per task and they are cached.
   If Claude is down, a plain template is used. Nothing is ever sent
   to a teacher by the app: Rohan copies the draft and sends it himself.
   ===================================================================== */

var DEBRIEF_SYSTEM = 'You write a 30-second check-in for a 15-year-old after a specific homework task. Use the task text only. ' +
  'Q1: what did you complete - 4-6 task-specific options covering all done, part done (name the parts), started, not started, stuck. ' +
  'Q2 (optional): one low-stakes retrieval question about the content (not a gotcha, answerable from doing the task), 3-4 options, one correct, short feedback. ' +
  'Q3: confidence 1-5. Friendly, plain UK English, no sarcasm, no hyphens. JSON only. Schema: ' +
  '{"q1":{"prompt":str,"options":[{"id":str,"label":str,"outcome":"all|part|started|not_started|stuck","completesParts":[str]}]},' +
  '"q2":{"prompt":str,"options":[{"id":str,"label":str,"correct":bool}],"feedback":str}|null,"q3":{"prompt":"How confident do you feel about this now?","scale":5}}';

var DEBRIEF_OUTCOMES = ['all', 'part', 'started', 'not_started', 'stuck'];
var DEBRIEF_XP = { debrief: 10, all: 20, part: 10, stuck: 10, q2: 5 };

/** The plain version, used when Claude is down, over budget or returns something odd. */
function debriefTemplate_(title) {
  var t = clip_(title, 80) || 'this task';
  return {
    q1: {
      prompt: 'How did "' + t + '" go?',
      options: [
        { id: 'o1', label: 'All done', outcome: 'all', completesParts: [] },
        { id: 'o2', label: 'Part done, some left to do', outcome: 'part', completesParts: [] },
        { id: 'o3', label: 'Started it', outcome: 'started', completesParts: [] },
        { id: 'o4', label: 'Not started yet', outcome: 'not_started', completesParts: [] },
        { id: 'o5', label: 'Stuck, I need help', outcome: 'stuck', completesParts: [] }
      ]
    },
    q2: null,
    q3: { prompt: 'How confident do you feel about this now?', scale: 5 },
    generic: true
  };
}

/** Returns a clean debrief or null. Every field is checked, nothing from Claude is trusted. */
function debriefValidate_(d) {
  try {
    if (!d || !d.q1 || !Array.isArray(d.q1.options)) return null;
    var seen = {}, opts = [];
    d.q1.options.slice(0, 6).forEach(function (o, i) {
      if (!o || DEBRIEF_OUTCOMES.indexOf(o.outcome) < 0) return;
      var id = clip_(o.id, 12).replace(/[^a-z0-9_]/gi, '') || 'o' + (i + 1);
      if (seen[id]) id = id + i;
      seen[id] = 1;
      opts.push({ id: id, label: clip_(o.label, 90).replace(/[<>]/g, ''), outcome: o.outcome, completesParts: (Array.isArray(o.completesParts) ? o.completesParts : []).slice(0, 6).map(function (x) { return clip_(x, 60).replace(/[<>]/g, ''); }) });
    });
    var kinds = {};
    opts.forEach(function (o) { kinds[o.outcome] = 1; });
    if (opts.length < 4 || !kinds.all || !kinds.not_started || !kinds.stuck) return null;
    var out = { q1: { prompt: clip_(d.q1.prompt, 140).replace(/[<>]/g, '') || 'How did it go?', options: opts }, q2: null, q3: { prompt: 'How confident do you feel about this now?', scale: 5 } };
    if (d.q2 && Array.isArray(d.q2.options)) {
      var q2o = d.q2.options.slice(0, 4).map(function (o, i) { return { id: 'q' + (i + 1), label: clip_(o && o.label, 90).replace(/[<>]/g, ''), correct: !!(o && o.correct === true) }; }).filter(function (o) { return o.label; });
      var right = q2o.filter(function (o) { return o.correct; }).length;
      if (q2o.length >= 3 && right === 1 && d.q2.prompt) out.q2 = { prompt: clip_(d.q2.prompt, 160).replace(/[<>]/g, ''), options: q2o, feedback: clip_(d.q2.feedback, 160).replace(/[<>]/g, '') };
    }
    return out;
  } catch (e) { return null; }
}

/** Finds the thing being ticked off: an Agenda row or a Homework scan row. */
function debriefTarget_(id) {
  if (String(id).indexOf('hw:') === 0) {
    var h = getRows('Homework', function (x) { return String(x.id) === String(id).slice(3); })[0];
    if (!h) throw new Error('Could not find that task.');
    return { kind: 'hw', id: id, row: h, title: h.task, details: '', subject: h.subject };
  }
  var a = getRows('Agenda', function (x) { return x.id === id; })[0];
  if (!a) throw new Error('Could not find that task.');
  return { kind: 'agenda', id: id, row: a, title: a.title, details: a.details, subject: a.subject };
}

/** Cached per task. Regenerated only when the title or details change. */
function getDebrief_(target) {
  var h = hash_(target.title + '|' + target.details), key = 'debrief:' + target.id;
  var hit = getRows('Debriefs', function (r) { return r.agendaId === target.id; })[0];
  if (hit && hit.hash === h) { try { var c = JSON.parse(hit.json); if (c && c.q1) return c; } catch (e) {} }
  var d = null;
  if (props_().getProperty('ANTHROPIC_KEY')) {
    try {
      d = debriefValidate_(callClaude_(DEBRIEF_SYSTEM, [{ role: 'user', content: JSON.stringify({ subject: target.subject, title: target.title, details: target.details }) }], 900));
    } catch (e) { log_('system', 'debriefclaude', String(e).slice(0, 100)); }
  }
  if (!d) d = debriefTemplate_(target.title);
  upsertRow('Debriefs', { agendaId: target.id, hash: h, json: JSON.stringify(d), createdAt: nowIso_() }, 'agendaId');
  return d;
}

function minutesBetween_(startedAt, now) {
  if (!startedAt) return 0;
  var a = new Date(startedAt).getTime(), b = (now || new Date()).getTime();
  if (isNaN(a) || b < a) return 0;
  return Math.min(240, Math.round((b - a) / 60000));
}

function xpAward_(note, want, action) {
  var room = Math.max(0, Number(getSetting('dailyXpCap')) - xpToday_()), xp = Math.min(want, room);
  addRow('XPLog', { ts: today_() + nowIso_().slice(10), action: action || 'debrief', xp: String(xp), note: clip_(note, 60) });
  return xp;
}

/** What Rohan sees when he taps Done. */
G2_ACTIONS.debriefGet = function (role, p) {
  rohanOnly_(role);
  var id = p.agendaId;
  if (!id && p.blockId) { var b = findBlock_(p.blockId); id = blockIds_(b)[0]; }
  if (!id) throw new Error('Pick a task first.');
  var t = debriefTarget_(id);
  var d = getDebrief_(t);
  // the right answer is checked on the server, so it is not sent to the page
  var q2 = d.q2 ? { prompt: d.q2.prompt, options: d.q2.options.map(function (o) { return { id: o.id, label: o.label }; }) } : null;
  var sp = t.kind === 'agenda' && t.row.sparxPct !== '' && t.row.sparxPct != null ? Number(t.row.sparxPct) : null;
  return {
    agendaId: id, title: clip_(t.title, 120), subject: t.subject, generic: !!d.generic,
    q1: { prompt: d.q1.prompt, options: d.q1.options.map(function (o) { return { id: o.id, label: o.label }; }) },
    q2: q2, q3: d.q3, sparxPct: sp,
    privacy: 'Mum and dad can see your debrief answers. They cannot see your Echo chats.'
  };
};

/** Records the debrief and moves the task and the block on. Honesty is never penalised. */
G2_ACTIONS.debriefSubmit = function (role, p) {
  rohanOnly_(role);
  var id = p.agendaId, t = debriefTarget_(id), d = getDebrief_(t);
  var opt = d.q1.options.filter(function (o) { return o.id === p.q1Id; })[0];
  if (!opt) throw new Error('Pick one of the answers first.');
  var conf = Math.max(0, Math.min(5, Number(p.confidence) || 0));
  var b = p.blockId ? getRows('Blocks', function (x) { return x.blockId === p.blockId; })[0] : null;
  var mins = b ? minutesBetween_(b.startedAt) : Math.max(0, Math.min(240, Number(p.minutesActual) || 0));
  if (!mins && b) mins = Math.max(0, minutesOf_(b.end) - minutesOf_(b.start));

  var q2Correct = '';
  if (d.q2 && p.q2Id) {
    var a2 = d.q2.options.filter(function (o) { return o.id === p.q2Id; })[0];
    q2Correct = a2 ? (a2.correct ? 'yes' : 'no') : '';
  }
  var partsDone = opt.completesParts || [], remaining = [];
  if (opt.outcome === 'part') {
    var chosen = {};
    (Array.isArray(p.partsDone) ? p.partsDone : []).forEach(function (x) { chosen[String(x)] = 1; });
    var all = [];
    d.q1.options.forEach(function (o) { (o.completesParts || []).forEach(function (x) { if (all.indexOf(x) < 0) all.push(x); }); });
    remaining = all.filter(function (x) { return partsDone.indexOf(x) < 0 && !chosen[x]; });
    if (!remaining.length) remaining = [clip_(p.remaining, 80) || 'The rest of ' + clip_(t.title, 50)];
  }

  // XP, inside the daily cap
  var xp = 0;
  xp += xpAward_(t.title, DEBRIEF_XP.debrief, 'debrief');
  if (opt.outcome === 'all') xp += xpAward_(t.title, DEBRIEF_XP.all, 'debrief_all');
  else if (opt.outcome === 'part') xp += xpAward_(t.title, DEBRIEF_XP.part, 'debrief_part');
  else if (opt.outcome === 'stuck') xp += xpAward_(t.title, DEBRIEF_XP.stuck, 'debrief_stuck');
  if (q2Correct) xp += xpAward_(t.title, DEBRIEF_XP.q2, 'debrief_q2');

  var cid = 'c_' + uid_();
  addRow('Completions', {
    completionId: cid, agendaId: id, blockId: p.blockId || '', at: nowIso_(), outcome: opt.outcome, optionIds: JSON.stringify([opt.id, p.q2Id || ''].filter(Boolean)),
    partsDone: JSON.stringify(partsDone), partsRemaining: JSON.stringify(remaining), q2Correct: q2Correct, confidence: String(conf || ''), minutesActual: String(mins), xp: String(xp),
    verifiedBy: '', verifiedOn: '', verifyNote: ''
  });

  // task state
  var next = { keep: false, remaining: remaining, hint: false };
  if (t.kind === 'agenda') {
    var patch = { id: id, debriefId: cid };
    if (opt.outcome === 'all') { patch.progressState = 'done'; patch.status = 'done'; patch.remainingParts = ''; }
    else if (opt.outcome === 'part') {
      patch.progressState = 'part'; patch.remainingParts = JSON.stringify(remaining);
      patch.chunks = JSON.stringify(remaining.map(function (x) { return { label: x, minutes: 20 }; }));
      patch.estHash = hash_(t.title + '|' + t.details); patch.estMinutes = String(20 * remaining.length);
    } else if (opt.outcome === 'started') patch.progressState = 'started';
    else if (opt.outcome === 'stuck') patch.progressState = 'stuck';
    upsertRow('Agenda', patch, 'id');
  } else if (opt.outcome === 'all') upsertRow('Homework', { id: String(id).slice(3), status: 'done' }, 'id');
  next.keep = opt.outcome !== 'all';

  // the block itself is used up whatever the outcome, so it never shows as missed
  if (b && (b.state === 'committed' || b.state === 'suggested' || b.state === 'missed')) setBlock_(b, { state: 'done', startedAt: b.startedAt || nowIso_(), handled: 'TRUE' });

  // part: book the rest. started and not started: the planner offers the next slot on its own.
  if (next.keep && opt.outcome !== 'stuck') { try { proposePlan_([today_(), addDays_(today_(), 1)], true); } catch (e) { log_('system', 'debriefplan', String(e).slice(0, 100)); } }

  var res = { ok: true, outcome: opt.outcome, xp: xp, completionId: cid, keepOpen: next.keep, remaining: remaining };
  if (d.q2 && q2Correct) { res.q2 = { correct: q2Correct === 'yes', feedback: d.q2.feedback, right: (d.q2.options.filter(function (o) { return o.correct; })[0] || {}).label }; }
  if (opt.outcome === 'stuck') { res.stuck = true; res.teacherDraft = teacherDraft_(t); res.itemId = id; stuckCheck_(id, t); }
  var sp = t.kind === 'agenda' && t.row.sparxPct !== '' && t.row.sparxPct != null ? Number(t.row.sparxPct) : null;
  if (opt.outcome === 'all' && sp != null && sp < 100) res.sparxNote = 'Sparx says ' + sp + '%. Maybe a few left?';
  return res;
};

/** A message he copies and sends himself. The app sends nothing. */
function teacherDraft_(t) {
  var what = clip_(t.title, 80);
  return 'Hi, I am stuck on ' + what + '. I have tried ______. Could you explain ______? Thank you.';
}
G2_ACTIONS.debriefTeacherDraft = function (role, p) { rohanOnly_(role); return { draft: teacherDraft_(debriefTarget_(p.agendaId)) }; };

/** Stuck flagged twice on the same item tells parents. Honesty is never penalised, the note is gentle. */
function stuckCheck_(id, t) {
  var n = getRows('Completions', function (c) { return c.agendaId === id && c.outcome === 'stuck'; }).length;
  if (n >= 2) parentAlert_('stuck_' + id, 'Rohan has asked for help twice on one task', 'He has marked "' + clip_(t.title, 80) + '" as stuck twice. That is him being honest, which is a good sign. A gentle "what would help?" is better than a push. A message to the teacher might be the next step.');
}

/** Parent ticks a completion as checked. Shown to Rohan as a small badge, never removes XP. */
G2_ACTIONS.completionVerify = function (role, p) {
  parentOnly_(role);
  var by = String(p.by || '').toLowerCase() === 'mum' ? 'Mum' : 'Dad';
  var c = getRows('Completions', function (x) { return x.completionId === p.completionId; })[0];
  if (!c) throw new Error('Could not find that one.');
  upsertRow('Completions', { completionId: c.completionId, verifiedBy: by, verifiedOn: today_(), verifyNote: clip_(p.note, 120) }, 'completionId');
  if (c.agendaId && String(c.agendaId).indexOf('hw:') !== 0) upsertRow('Agenda', { id: c.agendaId, verifiedBy: by, verifiedOn: today_() }, 'id');
  try { nudgeRohan_('badge', 'Home Base checked ' + clip_(c.agendaId && String(c.agendaId).indexOf('hw:') !== 0 ? ((getRows('Agenda', function (x) { return x.id === c.agendaId; })[0] || {}).title || 'your task') : 'your task', 60) + '. Nice work.', { force: true }); } catch (e) {}
  return { ok: true, verifiedBy: by };
};

/** Estimate skill: planned minutes against real minutes, in words, over the last 14 days. */
function estimateReview_() {
  var from = addDays_(today_(), -14), diffs = [];
  getRows('Completions', function (c) { return String(c.at).slice(0, 10) >= from && c.outcome === 'all' && Number(c.minutesActual) > 0; }).forEach(function (c) {
    var a = getRows('Agenda', function (x) { return x.id === c.agendaId; })[0];
    if (a && Number(a.estMinutes) > 0) diffs.push(Number(c.minutesActual) - Number(a.estMinutes));
  });
  if (diffs.length < 3) return 'Not enough finished tasks yet to compare your estimates.';
  var avg = Math.round(diffs.reduce(function (s, x) { return s + x; }, 0) / diffs.length);
  if (Math.abs(avg) <= 5) return 'Your time estimates are spot on this fortnight.';
  return avg > 0 ? 'Tasks are taking about ' + avg + ' minutes longer than planned. Worth adding a little more time.' : 'You are finishing about ' + Math.abs(avg) + ' minutes quicker than planned. Nice work.';
}

/** The list the parent view and digest use. */
function completionsView_(days) {
  var from = addDays_(today_(), -(days || 7));
  return getRows('Completions', function (c) { return String(c.at).slice(0, 10) >= from; }).reverse().map(function (c) {
    var a = String(c.agendaId).indexOf('hw:') === 0 ? null : getRows('Agenda', function (x) { return x.id === c.agendaId; })[0];
    var hw = String(c.agendaId).indexOf('hw:') === 0 ? getRows('Homework', function (x) { return String(x.id) === String(c.agendaId).slice(3); })[0] : null;
    var title = a ? a.title : hw ? hw.task : 'Task';
    var sp = a && a.sparxPct !== '' && a.sparxPct != null ? Number(a.sparxPct) : null;
    return { completionId: c.completionId, at: c.at, title: clip_(title, 100), outcome: c.outcome, q2Correct: c.q2Correct, confidence: c.confidence, minutes: c.minutesActual, sparxPct: sp, verifiedBy: c.verifiedBy, verifiedOn: c.verifiedOn };
  });
}
