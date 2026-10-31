/* =====================================================================
   Watcher.gs  (Prompt 22, section 5)
   School emails reach the app by one of two routes:
     1. Gmail: school mail is forwarded to the GamePlan Gmail, labelled GP/school.
     2. doPost: a scheduled helper or Power Automate posts {secret, messageId, from, subject, receivedAt, bodyText}.
   Both routes end in ingestMail_(). Raw bodies are never stored.
   ===================================================================== */

var WATCH_SYSTEM = 'Classify a UK secondary school email for a family. Rohan is Year 10. Ignore items for other year groups. Never include sensitive detail in rohanSummary. JSON only. Schema: ' +
  '{"category":"homework|test|event|deadline|behaviour|achievement|attendance|closure|trip|payment|general","urgency":"urgent|today|normal|low","relevantToRohan":bool,"audience":"both|parents",' +
  '"parentSummary":str(<=60 words),"rohanSummary":str|null(<=25 words, supportive),"items":[{"type":str,"subject":str,"title":str,"due":"YYYY-MM-DD","time":"HH:MM|null","location":str|null,"confidence":0-1}],"conversationStarter":str|null}. Plain UK English, no hyphens.';
var WATCH_CATS = ['homework', 'test', 'event', 'deadline', 'behaviour', 'achievement', 'attendance', 'closure', 'trip', 'payment', 'general'];
var WATCH_URG = ['urgent', 'today', 'normal', 'low'];
var PARENT_ONLY_CATS = ['behaviour', 'attendance', 'payment'];
var SAFEGUARD_RE = /safeguard|child protection|disclos|self.?harm|bullying|police|social services|exclusion/i;

/** Constant time compare, so the secret cannot be guessed one character at a time. */
function safeEq_(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  var n = Math.max(a.length, b.length), diff = a.length ^ b.length;
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Rules in code, not just in the prompt. Returns a clean classification. */
function classifyClean_(c, subject, body) {
  c = c || {};
  var out = {
    category: WATCH_CATS.indexOf(c.category) > -1 ? c.category : 'general',
    urgency: WATCH_URG.indexOf(c.urgency) > -1 ? c.urgency : 'normal',
    relevantToRohan: c.relevantToRohan !== false,
    audience: c.audience === 'parents' ? 'parents' : 'both',
    parentSummary: clip_(c.parentSummary, 400).replace(/[<>]/g, ''),
    rohanSummary: c.rohanSummary ? clip_(c.rohanSummary, 200).replace(/[<>]/g, '') : '',
    items: [], conversationStarter: c.conversationStarter ? clip_(c.conversationStarter, 200).replace(/[<>]/g, '') : '', safeguarding: false
  };
  (Array.isArray(c.items) ? c.items : []).slice(0, 6).forEach(function (i) {
    if (!i || !i.title || !validDate_(i.due || '')) return;
    out.items.push({ type: ARBOR_TYPES.indexOf(i.type) > -1 ? i.type : 'homework', subject: clip_(i.subject, 40), title: clip_(i.title, 120).replace(/[<>]/g, ''), due: i.due, time: validTime_(i.time || '') && i.time ? i.time : '', location: clip_(i.location, 60), confidence: Math.max(0, Math.min(1, Number(i.confidence) || 0.5)) });
  });
  var text = String(subject || '') + ' ' + String(body || '') + ' ' + out.parentSummary;
  if (SAFEGUARD_RE.test(text)) { out.safeguarding = true; out.audience = 'parents'; }
  if (PARENT_ONLY_CATS.indexOf(out.category) > -1) out.audience = 'parents';
  if (out.category === 'achievement' && String(getSetting('shareAchievements')) !== '1') out.audience = 'parents';
  if (out.audience === 'parents') out.rohanSummary = '';
  return out;
}

/** Claude down: a rule based fallback that keeps everything parent only. */
function classifyFallback_(subject) {
  var s = String(subject || '');
  var cat = /closure|closed|snow|inset/i.test(s) ? 'closure' : /trip/i.test(s) ? 'trip' : /test|exam|mock/i.test(s) ? 'test' : /homework|sparx|due/i.test(s) ? 'homework' : 'general';
  return { category: cat, urgency: 'normal', relevantToRohan: true, audience: 'parents', parentSummary: 'School email: ' + clip_(s, 100) + '. Open the original to read it.', rohanSummary: '', items: [], conversationStarter: '', safeguarding: SAFEGUARD_RE.test(s) };
}

function classifyMessage_(subject, body) {
  var c = null;
  if (props_().getProperty('ANTHROPIC_KEY')) {
    try { c = callClaude_(WATCH_SYSTEM, [{ role: 'user', content: 'Subject: ' + clip_(subject, 200) + '\n\n' + clip_(body, 6000) }], 900); }
    catch (e) { log_('system', 'watchclaude', String(e).slice(0, 100)); }
  }
  return c ? classifyClean_(c, subject, body) : classifyFallback_(subject);
}

/** True when Rohan may see a transmission about it. */
function rohanMaySee_(c) { return c.audience === 'both' && c.relevantToRohan && !c.safeguarding && !!c.rohanSummary; }

/** The one door every message goes through. Dedupes on the message id. */
function ingestMail_(m) {
  var id = clip_(m.messageId, 200);
  if (!id) return { ok: false, reason: 'no id' };
  if (getRows('Messages', function (x) { return x.messageId === id; }).length) return { ok: true, dup: true };
  var c = classifyMessage_(m.subject, m.bodyText);
  var now = p22Now_(), quiet = isQuiet_(now);
  var heldUntil = '';
  // quiet hours: stored now, told about at 07:00. Closure and urgent, or safeguarding to parents, go straight away.
  var rush = (c.urgency === 'urgent' && c.category === 'closure') || c.safeguarding;
  if (quiet && !rush) heldUntil = fmtD_(now) + 'T' + getSetting('quietEnd');
  if (quiet && !rush && Number(Utilities.formatDate(now, tz_(), 'H')) >= 12) heldUntil = addDays_(fmtD_(now), 1) + 'T' + getSetting('quietEnd');
  var row = {
    messageId: id, receivedAt: clip_(m.receivedAt, 30) || nowIso_(), from: clip_(m.from, 80).replace(/[<>]/g, ''), subject: clip_(m.subject, 140).replace(/[<>]/g, ''),
    category: c.category, urgency: c.urgency, audience: c.audience, parentSummary: c.parentSummary, rohanSummary: c.rohanSummary,
    itemsJSON: JSON.stringify({ items: c.items, starter: c.conversationStarter, rohan: rohanMaySee_(c) }), alertedParentsAt: '', alertedRohanAt: '', heldUntil: heldUntil, ackBy: ''
  };
  addRow('Messages', row);
  // dated items go to the agenda and so to the calendar and the planner
  c.items.forEach(function (i) {
    if (i.confidence < 0.5) return;
    var key = 'mail:' + hash_(id + '|' + i.title + '|' + i.due).slice(0, 16);
    if (getRows('Agenda', function (a) { return a.id === key; }).length) return;
    upsertRow('Agenda', { id: key, extKey: key, type: i.type, subject: i.subject, title: i.title, details: '', setDate: today_(), dueDate: i.due, dueTime: i.time, location: i.location, status: 'open', overdue: 'FALSE', source: 'watcher', confidence: String(i.confidence), lastChecked: today_(), progressState: 'none', dueChanged: 'FALSE', arborMissing: 'FALSE', audience: rohanMaySee_(c) ? 'both' : 'parents' }, 'id');
  });
  if (!heldUntil) deliverMessage_(id);
  return { ok: true, id: id, category: c.category, held: !!heldUntil };
}

/** Tells parents (always) and Rohan (only if the rules allow). */
function deliverMessage_(id) {
  var m = getRows('Messages', function (x) { return x.messageId === id; })[0];
  if (!m || m.alertedParentsAt) return false;
  var extra = {}; try { extra = JSON.parse(m.itemsJSON || '{}'); } catch (e) {}
  var h = '<p>' + esc_(m.parentSummary) + '</p>' + (extra.starter ? '<p><i>Conversation starter: ' + esc_(extra.starter) + '</i></p>' : '');
  mail_('GamePlan · School message: ' + clip_(m.subject, 100), h);
  var patch = { messageId: id, alertedParentsAt: nowIso_(), heldUntil: '' };
  if (extra.rohan && m.rohanSummary) {
    if (nudgeRohan_('message', m.rohanSummary, { force: true, key: 'msg:' + id })) patch.alertedRohanAt = nowIso_();
  }
  upsertRow('Messages', patch, 'messageId');
  return true;
}

/** Called every 15 minutes by alertsTick. Releases anything held that is now due. */
function releaseHeld_() {
  var now = Utilities.formatDate(p22Now_(), tz_(), "yyyy-MM-dd'T'HH:mm"), n = 0;
  if (isQuiet_(p22Now_())) return 0;
  getRows('Messages', function (m) { return m.heldUntil && !m.alertedParentsAt && String(m.heldUntil) <= now; }).forEach(function (m) { if (deliverMessage_(m.messageId)) n++; });
  return n;
}

/** Route 1: the GamePlan Gmail. */
function watchSchoolMail() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 'busy';
  var n = 0;
  try {
    MEMO_ = {};
    props_().setProperty('watcher_last', String(Date.now()));
    var threads = GmailApp.search('label:GP/school -label:GP/seen newer_than:7d', 0, 20);
    var seen = GmailApp.getUserLabelByName('GP/seen') || GmailApp.createLabel('GP/seen');
    threads.forEach(function (t) {
      t.getMessages().forEach(function (msg) {
        var mid = '';
        try { mid = msg.getHeader('Message-ID'); } catch (e) {}
        var r = ingestMail_({ messageId: mid || ('gm:' + msg.getId()), from: msg.getFrom(), subject: msg.getSubject(), receivedAt: Utilities.formatDate(msg.getDate(), tz_(), "yyyy-MM-dd'T'HH:mm:ss"), bodyText: msg.getPlainBody() });
        if (r.ok && !r.dup) n++;
      });
      t.addLabel(seen);
    });
  } catch (e) { log_('system', 'watchfail', String(e).slice(0, 150)); throw e; }
  finally { lock.releaseLock(); }
  return n + ' new';
}

/** Route 2: a POST from Power Automate or a scheduled helper. */
function doPost(e) {
  var out = function (o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); };
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var secret = props_().getProperty('watcherSecret');
    if (!secret || !safeEq_(body.secret, secret)) { log_('system', 'postreject', 'bad secret'); return out({ ok: false, error: 'no' }); }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return out({ ok: false, error: 'busy' });
    try { MEMO_ = {}; props_().setProperty('watcher_last', String(Date.now())); return out(ingestMail_(body)); }
    finally { lock.releaseLock(); }
  } catch (err) { log_('system', 'postfail', String(err).slice(0, 120)); return out({ ok: false, error: 'bad request' }); }
}

/** Run once from the editor to create the shared secret. The value is shown in the log only. */
function makeWatcherSecret() {
  var p = props_();
  if (p.getProperty('watcherSecret')) return 'A secret already exists. Delete the watcherSecret script property first if you want a new one.';
  p.setProperty('watcherSecret', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  return 'Secret created. Read it in Project Settings, Script Properties, watcherSecret.';
}
