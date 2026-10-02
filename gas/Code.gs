/**
 * Gmail -> 12306ics bridge.
 *
 * Runs every minute (time-driven trigger), finds 12306 emails that have not
 * been delivered yet and POSTs them to the Worker's /ingest endpoint.
 * A message is marked "done" only after the Worker returns 2xx, so transient
 * failures are retried on the next run.
 *
 * Setup (once):
 *   1. Paste this file into a new Apps Script project (script.google.com).
 *   2. Project Settings -> Script Properties: add ENDPOINT and TOKEN
 *      (optional: QUERY to override the Gmail search).
 *   3. Run `setup` once, accept the authorization prompt.
 */

var DEFAULT_QUERY = 'from:12306@rails.com.cn newer_than:7d';
var MAX_ATTEMPTS = 10;
var STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ENDPOINT') || !props.getProperty('TOKEN')) {
    throw new Error('Set ENDPOINT and TOKEN in Script Properties first');
  }
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'poll';
  });
  if (!exists) {
    ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
  }
  poll();
  Logger.log('Trigger installed. Endpoint: ' + props.getProperty('ENDPOINT'));
}

function poll() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    pollUnlocked();
  } finally {
    lock.releaseLock();
  }
}

function pollUnlocked() {
  var props = PropertiesService.getScriptProperties();
  var endpoint = props.getProperty('ENDPOINT');
  var token = props.getProperty('TOKEN');
  if (!endpoint || !token) throw new Error('Set ENDPOINT and TOKEN in Script Properties');
  var query = props.getProperty('QUERY') || DEFAULT_QUERY;
  var state = JSON.parse(props.getProperty('STATE') || '{}');
  var changed = false;

  var threads = GmailApp.search(query, 0, 50);
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      // Prefer the RFC Message-ID so Cloudflare Email Routing and this bridge deduplicate against each other.
      var id = messageKey(msg);
      var st = state[id];
      if (st && (st.s === 'done' || st.s === 'failed')) continue;

      var payload = {
        id: id,
        threadId: threads[i].getId(),
        from: msg.getFrom(),
        to: msg.getTo(),
        subject: msg.getSubject(),
        date: msg.getDate().toISOString(),
        html: msg.getBody(),
        text: msg.getPlainBody(),
      };

      var code, body;
      try {
        var res = UrlFetchApp.fetch(endpoint, {
          method: 'post',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        code = res.getResponseCode();
        body = res.getContentText();
      } catch (e) {
        code = 0;
        body = String(e);
      }

      var attempts = (st && st.n ? st.n : 0) + 1;
      if (code >= 200 && code < 300) {
        state[id] = { s: 'done', t: Date.now(), r: body.slice(0, 300) };
      } else if (code >= 400 && code < 500) {
        state[id] = { s: 'failed', t: Date.now(), n: attempts, c: code, r: body.slice(0, 300) };
      } else {
        state[id] = { s: attempts >= MAX_ATTEMPTS ? 'failed' : 'retry', t: Date.now(), n: attempts, c: code, r: body.slice(0, 300) };
      }
      changed = true;
      Logger.log('[' + state[id].s + '] ' + code + ' ' + payload.subject + ' -> ' + body.slice(0, 200));
    }
  }

  // Forget old entries so the property never grows without bound.
  var cutoff = Date.now() - STATE_TTL_MS;
  Object.keys(state).forEach(function (k) {
    if (state[k].t < cutoff) {
      delete state[k];
      changed = true;
    }
  });
  if (changed) props.setProperty('STATE', JSON.stringify(state));
}

function messageKey(msg) {
  var header = '';
  try {
    header = msg.getHeader('Message-ID') || '';
  } catch (e) {
    header = '';
  }
  var m = header.trim().match(/^<?([^<>\s]+)>?$/);
  return m ? m[1] : msg.getId();
}

/** Print the delivery state of recent messages. */
function status() {
  var state = JSON.parse(PropertiesService.getScriptProperties().getProperty('STATE') || '{}');
  Object.keys(state).forEach(function (id) {
    Logger.log(id + ' ' + JSON.stringify(state[id]));
  });
}

/** Forget one message id (or all when omitted) so it is delivered again on the next poll. */
function reset(id) {
  var props = PropertiesService.getScriptProperties();
  if (!id) {
    props.deleteProperty('STATE');
    return;
  }
  var state = JSON.parse(props.getProperty('STATE') || '{}');
  delete state[id];
  props.setProperty('STATE', JSON.stringify(state));
}
