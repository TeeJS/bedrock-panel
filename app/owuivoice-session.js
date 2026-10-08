'use strict';
// Open WebUI session ADAPTER for the generic voice-panel host (voicepanel-host.js header has the
// contract). Unlike the three CLI adapters there is no child process: a "session" is just an
// in-memory conversation history, and each turn is one streaming chat completion against the
// shared Auth-tab connection (settings.owui via resolveOwui). That means:
//   - no modes and no approvals — listModes() is [] (hides the Mode button), decideApproval()
//     is always false, and no 'approval' event is ever emitted;
//   - projectDir() is '' — there is no working directory (the page's folder button is vestigial);
//   - stop/interrupt destroy the in-flight HTTP stream instead of killing a process;
//   - a truncated reply (finish_reason 'length') is a 'notice', not an error — the partial text
//     is already on screen, visibly cut off, which beats discarding it.
//
// Models come from /api/models after start (async — 'models-changed' repaints the picker).
// validModel stays permissive until that list loads: a failed model fetch must never brick the
// page's Settings writes.
//
// Tools: Open WebUI only runs a model's tools (MCP servers, workspace tools, skills) for a turn
// attached to a saved chat, and returns the answer in that chat rather than in a stream (see
// owuiClient.runToolChat). So a model with tools or skills attached in Open WebUI takes that path
// -- the whole answer arrives at once, after the tools ran -- and every other model streams as
// before. On the streaming path any tool-call markup the model writes as text is filtered out of
// what is shown and spoken, with a notice instead.

const { EventEmitter } = require('events');
const defaultClient = require('./owuiClient');

const HISTORY_MAX = 40;            // messages (user+assistant) kept as context per session
const TURN_TIMEOUT_MS = 600000;    // socket-inactivity budget per turn; streaming resets it per chunk
const MODELS_WAIT_MS = 3000;       // a first turn waits this long for the model list (which says if it has tools)

// Tool-call markup a model writes out as text when nothing executes the call: Hermes/Qwen
// <tool_call>…</tool_call>, and Qwen3-Coder's <function=…>…</function> / <parameter=…>…</parameter>.
const TOOL_BLOCKS = [['<tool_call>', '</tool_call>'], ['<function=', '</function>'], ['<parameter=', '</parameter>']];
function toolNameIn(block) {
  const m = /<parameter=(?:tool_)?name>\s*([\w.:-]+)/.exec(block) || /"name"\s*:\s*"([^"]+)"/.exec(block) || /<function=([\w.:-]+)>/.exec(block);
  return m ? m[1] : '';
}
// Streaming filter: push() each delta, end() once; both return the text that is safe to show. A
// possible start of a marker at the end of a chunk is held back until the next one decides it.
function createToolMarkupFilter() {
  let buf = '';
  const names = [];
  let saw = false;
  function drain(final) {
    let out = '';
    for (;;) {
      let at = -1, pair = null;
      for (const p of TOOL_BLOCKS) { const i = buf.indexOf(p[0]); if (i >= 0 && (at < 0 || i < at)) { at = i; pair = p; } }
      if (at < 0) {
        let keep = 0;
        if (!final) {
          for (const p of TOOL_BLOCKS) {
            for (let k = Math.min(p[0].length - 1, buf.length); k > keep; k--) {
              if (p[0].startsWith(buf.slice(buf.length - k))) { keep = k; break; }
            }
          }
        }
        out += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        return out;
      }
      out += buf.slice(0, at);
      const close = buf.indexOf(pair[1], at);
      if (close < 0) {                        // block still arriving; an unterminated one at the end is dropped
        buf = buf.slice(at);
        if (final) { saw = true; const n = toolNameIn(buf); if (n) names.push(n); buf = ''; }
        return out;
      }
      saw = true;
      const n = toolNameIn(buf.slice(at, close));
      if (n && !names.includes(n)) names.push(n);
      buf = buf.slice(close + pair[1].length);
    }
  }
  return {
    push(t) { buf += t; return drain(false); },
    end() { return drain(true); },
    sawToolCall: () => saw,
    toolNames: () => names.slice(),
  };
}
// A model with tools or skills attached in Open WebUI takes the server-side tool-calling path.
function hasTools(info) { return !!info && ((info.toolIds || []).length > 0 || (info.skillIds || []).length > 0); }
// A finished answer from the tool path: drop collapsed <details> blocks (older Open WebUI
// versions serialize tool calls and reasoning that way) and any leftover tool-call markup.
function cleanAnswer(text) {
  const f = createToolMarkupFilter();
  const kept = f.push(String(text || '').replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '')) + f.end();
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

function createOwuiVoiceAdapter({ resolveOwui, log, client }) {
  const say = log || (() => {});
  const owui = client || defaultClient;
  const emitter = new EventEmitter();

  let running = false;
  let sid = null;            // 'owui-<ts>' once started
  let history = [];          // [{role:'user'|'assistant', content}] — the model's context
  let modelPick = '';        // per-page override ('' = Auth-tab default)
  let modelList = null;      // null until /api/models answers; then an array of id strings
  let modelInfo = {};        // id -> { toolIds, skillIds } from the same answer
  let modelsReady = null;    // settles when the model fetch ends, either way
  let turn = null;           // the in-flight turn: { cancel() } — one at a time
  let acc = '';              // assistant text accumulated for the current turn
  let profilePrompt = '';    // active AI profile instruction; prepended as a system message per request

  function cfg() { return (resolveOwui && resolveOwui()) || {}; }
  function endpoint() { return owui.normalizeOwuiUrl(cfg().url); }

  function mapError(e) {
    const status = e && e.statusCode;
    const msg = String((e && e.message) || 'request failed');
    if (status === 401 || status === 403) return 'Open WebUI rejected the API key (HTTP ' + status + ') — check the key on the Auth tab';
    if (status) return /^HTTP \d/.test(msg) ? 'Open WebUI error (HTTP ' + status + ')' : msg;   // tool-path errors already say which step
    if (/no response after/.test(msg)) return 'Open WebUI ' + msg;
    if (/^Open WebUI/.test(msg)) return msg;                                                   // the server's own error, or no answer
    return 'could not reach Open WebUI (' + msg + ') — is Open WebUI running?';
  }

  // Fire-and-forget model discovery; failure is logged, never fatal (validModel stays permissive).
  // The same answer says which models have tools or skills attached.
  function fetchModels() {
    const ep = endpoint();
    if (!ep) { modelsReady = null; return; }
    modelsReady = owui.listModelInfo(ep.modelsUrl, String(cfg().apiKey || '')).then(list => {
      modelList = list.map(m => m.id);
      modelInfo = {};
      for (const m of list) modelInfo[m.id] = m;
      const tooled = list.filter(hasTools).map(m => m.id);
      say('model list loaded (' + list.length + (tooled.length ? '; with tools: ' + tooled.join(', ') : '') + ')');
      emitter.emit('models-changed', {});
    }, e => say('model list unavailable: ' + ((e && e.message) || e)));
  }

  function finishTurn(text, error) {
    turn = null;
    acc = '';
    emitter.emit('turn-complete', { text: text || null, error: error || null });
  }
  function failTurn(e) {
    // Drop the failed user message so a retry doesn't double it in the context.
    if (history.length && history[history.length - 1].role === 'user') history.pop();
    const msg = mapError(e);
    say('turn failed: ' + msg);
    finishTurn(null, msg);
  }
  function landReply(text) {
    if (text) history.push({ role: 'assistant', content: text });
    if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
    emitter.emit('assistant-final', { text });
  }

  // Tools attached in Open WebUI: one server-side tool-calling round trip, the answer at the end.
  function runToolTurn(me, ep, model, messages, info) {
    say('turn via Open WebUI tools for ' + model + ' (' + info.toolIds.concat(info.skillIds).join(', ') + ')');
    const job = owui.runToolChat({ origin: ep.origin, apiKey: String(cfg().apiKey || ''), model, messages,
      toolIds: info.toolIds, skillIds: info.skillIds, timeoutMs: TURN_TIMEOUT_MS });
    me.cancel = () => job.cancel();
    job.promise.then(({ text }) => {
      if (turn !== me) return;                       // interrupted or stopped meanwhile
      const clean = cleanAnswer(text);
      acc = clean;
      if (clean) emitter.emit('assistant-delta', { text: clean });
      landReply(clean);
      finishTurn(clean, null);
    }, e => {
      if (turn !== me || (e && e.cancelled)) return;
      failTurn(e);
    });
  }

  // No tools attached: stream as before, with tool-call markup kept out of the text and speech.
  function runStreamTurn(me, ep, model, messages) {
    const filter = createToolMarkupFilter();
    const emitText = t => { if (t) { acc += t; emitter.emit('assistant-delta', { text: t }); } };
    const stream = owui.streamChat(ep.chatUrl, { model, stream: true, messages }, String(cfg().apiKey || ''), TURN_TIMEOUT_MS, {
      onDelta: t => emitText(filter.push(t)),
      onDone: ({ finishReason }) => {
        emitText(filter.end());
        const text = acc;
        landReply(text);
        if (finishReason === 'length') emitter.emit('notice', { text: 'Reply truncated — the model hit its context limit.' });
        if (filter.sawToolCall()) {
          const names = filter.toolNames();
          say('model wrote an unexecuted tool call as text' + (names.length ? ' (' + names.join(', ') + ')' : ''));
          const why = modelList === null ? "the panel couldn't load Open WebUI's model list to find its tools"
            : 'no tools are attached to it in Open WebUI';
          emitter.emit('notice', { text: model + ' tried to use ' + (names.length ? 'the tool ' + names.join(', ') : 'a tool') +
            ', but ' + why + ', so it could not run.' });
        }
        finishTurn(text, null);
      },
      onError: e => failTurn(e),
    });
    me.cancel = () => { try { stream.destroy(); } catch (e) {} };
  }

  function dispatch(me, model, messages) {
    if (turn !== me) return;                         // stopped while waiting for the model list
    const ep = endpoint();
    if (!ep) { failTurn(new Error('Open WebUI connection not configured')); return; }
    const info = modelInfo[model];
    if (hasTools(info)) {
      runToolTurn(me, ep, model, messages, info);
    } else {
      runStreamTurn(me, ep, model, messages);
    }
  }

  return {
    // ---- lifecycle ----
    start({ model, profilePrompt: pp }) {
      if (!endpoint()) {
        say('start refused: no usable Open WebUI URL configured');
        emitter.emit('error', { message: "Open WebUI connection not configured — set the URL on the editor's Auth tab." });
        return false;
      }
      if (turn) { try { turn.cancel(); } catch (e) {} turn = null; }
      running = true;
      sid = 'owui-' + Date.now();
      history = [];
      acc = '';
      modelPick = model || '';
      profilePrompt = String(pp || '');
      fetchModels();
      return true;
    },
    // AI profile switch — takes effect on the next request (system message prepended per send,
    // never evicted by the history cap). Instant, no restart.
    setProfilePrompt(text) { profilePrompt = String(text || ''); return true; },
    stop() {
      if (turn) { try { turn.cancel(); } catch (e) {} turn = null; }
      running = false;
      sid = null;
      history = [];
      acc = '';
    },
    sendTurn(text) {
      if (!running || turn) return false;
      const ep = endpoint();
      if (!ep) return false;
      const model = String(modelPick || cfg().model || '').trim();
      if (!model) {
        // Sendable-but-doomed would confuse the queueing host — accept the turn and fail it
        // with a wording that names the fix.
        emitter.emit('assistant-start');
        setImmediate(() => finishTurn(null, 'no Open WebUI model set — pick one with the Model button, or set a default on the Auth tab'));
        return true;
      }
      history.push({ role: 'user', content: text });
      if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
      acc = '';
      const me = { cancel() {} };
      turn = me;
      emitter.emit('assistant-start');
      const messages = (profilePrompt ? [{ role: 'system', content: profilePrompt }] : []).concat(history);
      // Whether the model has tools decides the path, so a turn sent before the model list has
      // answered (a lazily started session's first turn) waits for it, briefly.
      if (modelList === null && modelsReady) {
        Promise.race([modelsReady, new Promise(r => setTimeout(r, MODELS_WAIT_MS))]).then(() => dispatch(me, model, messages));
      } else {
        dispatch(me, model, messages);
      }
      return true;
    },
    isRunning() { return running; },
    sessionId() { return sid; },
    projectDir() { return ''; },
    interrupt() {
      if (!turn) return false;
      try { turn.cancel(); } catch (e) {}
      // Settle the turn with whatever streamed so far — the host is waiting on turn-complete.
      const partial = acc;
      if (partial) history.push({ role: 'assistant', content: partial });
      emitter.emit('assistant-final', { text: partial });
      finishTurn(partial, null);
      return true;
    },

    // ---- modes: none. '' + [] hide the Mode button on the shared page. ----
    setMode() { return false; },
    mode() { return ''; },
    listModes() { return []; },

    // ---- model: '' = the Auth-tab default; list fills in async after start ----
    setModel(pick) {
      if (!this.validModel(pick)) return false;
      modelPick = String(pick || '');
      emitter.emit('model', { model: modelPick || String(cfg().model || '') });
      return true;
    },
    currentModel() { return modelPick || String(cfg().model || '') || null; },
    validModel(pick) {
      if (pick === '' || pick == null) return true;
      if (typeof pick !== 'string') return false;
      return modelList === null ? true : modelList.includes(pick);   // permissive until the list loads
    },
    listModels() {
      const def = String(cfg().model || '').trim();
      return [{ id: '', label: 'Default' + (def ? ' (' + def + ')' : ' (Auth tab setting)') }]
        .concat((modelList || []).map(id => ({ id, label: id })));
    },

    // ---- approvals: none. Tools run inside Open WebUI, which never asks the panel. ----
    supportsAlwaysApproval: false,
    decideApproval() { return false; },
    cancelApprovals() {},

    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}

module.exports = { createOwuiVoiceAdapter };
