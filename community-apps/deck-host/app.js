'use strict';
// Stream Deck Host page. Buttons-first design: one slim rail of three buttons (Profile / Edit /
// Plugins) and the rest of the panel is deck keys on a hardware-style bezel plate. Everything
// informational lives behind those buttons in overlays.
//   Normal mode: touching a key sends keyDown on finger-down and keyUp on lift (authentic).
//   Edit mode: tapping ANY key -- assigned or empty -- opens the assignment overlay.
// The page reports its real grid area (w/h) with each poll; the server derives columns from it so
// the layout matches the device (rows = the "Key size" option; columns = what fits).
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('_dark') === '0') document.body.classList.add('light');
  var ACCENT = q.get('_accent');
  if (/^#[0-9a-fA-F]{6}$/.test(ACCENT || '')) document.documentElement.style.setProperty('--accent', ACCENT);

  var el = function (id) { return document.getElementById(id); };
  var grid = el('grid');
  var snap = null, assignSlot = null, movePending = null;
  var editing = false;
  var confirmRemoveId = null;
  var pollFails = 0;
  var iconCache = {};

  function post(action, body) {
    return fetch('/app-api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'panel lost the deck host' }; });
  }
  function gridArea() { return 'w=' + Math.max(0, grid.clientWidth) + '&h=' + Math.max(0, grid.clientHeight); }

  // ---- long-poll loop ---------------------------------------------------
  function poll(since) {
    fetch('/app-api/state?' + gridArea() + (since ? '&since=' + since : ''))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { pollFails = 0; snap = j; render(); poll(j.v); }
        else { pollFails++; render(); setTimeout(function () { poll(0); }, 2000); }
      })
      .catch(function () { pollFails++; render(); setTimeout(function () { poll(0); }, 2000); });
  }

  function flashKey(d, cls, ms) { d.classList.add(cls); setTimeout(function () { if (d.isConnected) d.classList.remove(cls); }, ms || 900); }
  function toast(msg, bad) {
    var t = el('toast');
    t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---- the rail (buttons only) ------------------------------------------
  function activeProfileName() {
    var pr = snap && (snap.profiles || []).find(function (p) { return p.id === snap.activeProfile; });
    return pr ? pr.name : '—';
  }
  function renderRail() {
    el('profilename').textContent = activeProfileName();
    el('editstate').textContent = editing ? 'On' : 'Off';
    el('editbtn').classList.toggle('on', editing);
    var ps = (snap && snap.plugins) || [];
    var skipped = (snap && snap.skipped) || [];
    var running = ps.filter(function (p) { return p.status === 'running'; }).length;
    var attention = ps.filter(function (p) { return p.status === 'crashed' || p.status === 'unsupported'; }).length + skipped.length;
    var dot = el('hostdot');
    if (pollFails >= 2) dot.className = 'dot bad';
    else dot.className = 'dot ' + (attention ? 'bad' : (running ? 'ok' : 'warn'));
    el('plugcount').textContent = ps.length ? (running + '/' + ps.length) : '—';
  }
  function statusText() {
    if (pollFails >= 2) return 'Panel lost the deck host — retrying…';
    var ps = (snap && snap.plugins) || [];
    var skipped = (snap && snap.skipped) || [];
    if (!ps.length) {
      if (!snap || !snap.folder) return 'Plugins folder not set — set it in this page’s options (and Save)';
      return skipped.length ? skipped.length + ' package(s) can’t run' : 'No plugins in ' + snap.folder;
    }
    var running = ps.filter(function (p) { return p.status === 'running'; }).length;
    var attention = ps.filter(function (p) { return p.status === 'crashed' || p.status === 'unsupported'; }).length + skipped.length;
    return running + '/' + ps.length + ' plugins running' + (attention ? ' · ' + attention + ' need attention' : '');
  }

  // ---- key grid ---------------------------------------------------------
  function actionIcon(plugin, iconPath, img) {
    if (!iconPath) return;
    var key = plugin + '|' + iconPath;
    if (iconCache[key]) { if (iconCache[key] !== 'x') img.src = iconCache[key]; return; }
    iconCache[key] = 'x';
    fetch('/app-api/asset?plugin=' + encodeURIComponent(plugin) + '&path=' + encodeURIComponent(iconPath))
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { iconCache[key] = 'data:' + j.mime + ';base64,' + j.b64; img.src = iconCache[key]; } })
      .catch(function () {});
  }
  function normalizeImage(img) {
    if (!img) return '';
    return /^data:/.test(img) ? img : 'data:image/png;base64,' + img;
  }
  function shortName(k) {
    if (k.builtin) return k.name || k.builtin;
    if (k.name && k.name.indexOf('.') < 0) return k.name;
    var parts = String(k.name || k.action || '').split('.');
    return parts[parts.length - 1] || 'key';
  }
  function render() {
    renderRail();
    if (!snap) return;
    var ps = snap.plugins || [];
    if (!ps.length && !(snap.skipped || []).length) {
      grid.style.gridTemplateColumns = '1fr'; grid.style.gridTemplateRows = '1fr';
      grid.innerHTML = '';
      var e0 = document.createElement('div'); e0.className = 'bigempty';
      e0.textContent = !snap.folder
        ? 'Set this page’s “Plugins folder” option in the editor (and Save), then drop *.sdPlugin folders or downloaded .streamDeckPlugin files into it.'
        : 'Drop *.sdPlugin folders or downloaded .streamDeckPlugin files into\n' + snap.folder;
      grid.appendChild(e0);
      return;
    }
    var lay = snap.layout || { columns: 8, rows: 3 };
    var availW = grid.clientWidth - 32 - (lay.columns - 1) * 8;
    var availH = grid.clientHeight - 32 - (lay.rows - 1) * 8;
    var ks = Math.max(64, Math.floor(Math.min(availW / lay.columns, availH / lay.rows)));
    grid.style.gridTemplateColumns = 'repeat(' + lay.columns + ', ' + ks + 'px)';
    grid.style.gridTemplateRows = 'repeat(' + lay.rows + ', ' + ks + 'px)';
    document.documentElement.style.setProperty('--kt', Math.max(16, Math.round(ks / 4.6)) + 'px');
    grid.innerHTML = '';
    for (var r = 0; r < lay.rows; r++) {
      for (var c = 0; c < lay.columns; c++) (function (c, r) {
        var pos = c + ',' + r;
        var k = snap.keys && snap.keys[pos];
        var d = document.createElement('div');
        d.className = 'key' + (k ? '' : ' empty');
        if (k) {
          var plug = k.builtin ? null : ps.find(function (p) { return p.id === k.plugin; });
          if (!k.builtin && (!plug || plug.status !== 'running')) d.classList.add('dead');
          var img = normalizeImage(k.image);
          var t = document.createElement('span'); t.className = 'kt';
          t.textContent = k.title || (img ? '' : shortName(k));
          if (img) {
            var im = document.createElement('img'); im.src = img; d.appendChild(im); d.classList.add('has-img');
            im.onerror = function () { im.remove(); d.classList.remove('has-img'); t.textContent = k.title || shortName(k); };
          } else if (k.icon) {
            var im2 = document.createElement('img'); actionIcon(k.plugin, k.icon, im2); d.appendChild(im2); d.classList.add('has-img');
          }
          if (t.textContent) d.appendChild(t);
          if (!k.builtin && !plug) { var miss = document.createElement('span'); miss.className = 'kt missing'; miss.textContent = 'needs ' + (k.plugin || 'plugin'); d.appendChild(miss); }
          if (k.builtin === 'unsupported') { var un = document.createElement('span'); un.className = 'kt missing'; un.textContent = 'not supported'; d.appendChild(un); }
          if (k.ok && Date.now() - k.ok < 1500) flashKey(d, 'okflash', 1500 - (Date.now() - k.ok));
          if (k.alert && Date.now() - k.alert < 1500) flashKey(d, 'alertflash', 1500 - (Date.now() - k.alert));
          wireAssigned(d, k, c, r);
        } else {
          var e = document.createElement('span'); e.className = 'kt';
          e.textContent = movePending ? '⤵' : (editing ? '+' : '');
          if (movePending) d.classList.add('movetarget');
          d.appendChild(e);
          d.addEventListener('click', function () {
            if (movePending) {
              var from = movePending; movePending = null;
              post('move', { fromCol: from.col, fromRow: from.row, toCol: c, toRow: r }).then(function (res) { if (!res.ok) { toast(res.error, true); render(); } });
              return;
            }
            if (editing) openAssign(c, r, null);
          });
        }
        grid.appendChild(d);
      })(c, r);
    }
  }
  function wireAssigned(d, k, c, r) {
    var downSent = false;
    d.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      if (movePending) { movePending = null; render(); return; }
      if (editing) return;
      downSent = true;
      d.classList.add('pressed');
      post('press', { context: k.context }).then(function (res) { if (!res.ok) { flashKey(d, 'alertflash'); toast(res.error + ' — see Plugins', true); } });
    });
    var lift = function () {
      d.classList.remove('pressed');
      if (downSent) { downSent = false; post('release', { context: k.context }); }
    };
    d.addEventListener('pointerup', lift);
    d.addEventListener('pointercancel', lift);
    d.addEventListener('pointerleave', function () { if (downSent) lift(); });
    d.addEventListener('click', function () { if (editing) openAssign(c, r, k); });
  }

  // ---- profile overlay ---------------------------------------------------
  el('profilebtn').addEventListener('click', function () { confirmRemoveId = null; renderProfilePane(); el('profilepane').hidden = false; });
  el('profileclose').addEventListener('click', function () { el('profilepane').hidden = true; });
  function renderProfilePane() {
    var list = el('profilelist');
    list.innerHTML = '';
    ((snap && snap.profiles) || []).forEach(function (pr) {
      var row = document.createElement('div'); row.className = 'prof';
      if (pr.id === confirmRemoveId) {
        var count = (snap.keys && pr.id === snap.activeProfile) ? Object.keys(snap.keys).length : null;
        var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'danger grow';
        rm.textContent = 'Remove "' + pr.name + '"' + (count ? ' and its ' + count + ' key' + (count === 1 ? '' : 's') : ' and its keys') + '?';
        rm.addEventListener('click', function () {
          confirmRemoveId = null;
          post('profile-remove', { id: pr.id }).then(function (r2) { if (!r2.ok) toast(r2.error, true); renderProfilePane(); });
        });
        var keep = document.createElement('button'); keep.type = 'button'; keep.textContent = 'Keep';
        keep.addEventListener('click', function () { confirmRemoveId = null; renderProfilePane(); });
        row.appendChild(rm); row.appendChild(keep);
      } else {
        var sel = document.createElement('button'); sel.type = 'button'; sel.className = 'grow' + (pr.id === snap.activeProfile ? ' on' : '');
        sel.textContent = pr.name;
        sel.addEventListener('click', function () { post('profile-select', { id: pr.id }).then(function () { el('profilepane').hidden = true; }); });
        row.appendChild(sel);
        var del = document.createElement('button'); del.type = 'button'; del.className = 'danger'; del.textContent = '✕';
        del.addEventListener('click', function () {
          if (((snap && snap.profiles) || []).length <= 1) { toast('The last profile can’t be removed.', true); return; }
          confirmRemoveId = pr.id; renderProfilePane();
        });
        row.appendChild(del);
      }
      list.appendChild(row);
    });
    var imp = (snap && snap.importables) || [];
    if (imp.length) {
      var lbl = document.createElement('div'); lbl.className = 'ov-label'; lbl.style.marginTop = '16px';
      lbl.textContent = 'Import from your plugins folder';
      list.appendChild(lbl);
      var trust = document.createElement('div'); trust.className = 'pk-empty'; trust.style.marginTop = '4px';
      trust.textContent = 'Imported profiles can carry keys that press keyboard shortcuts, type text, and open files or links on your PC — only import profiles you trust.';
      list.appendChild(trust);
      imp.forEach(function (f) {
        var row = document.createElement('div'); row.className = 'prof';
        var b = document.createElement('button'); b.type = 'button'; b.className = 'grow';
        b.textContent = '⇩ ' + f.name;
        b.addEventListener('click', function () {
          b.disabled = true; b.textContent = 'Importing…';
          post('import', { id: f.id }).then(function (r) {
            if (r.ok) {
              toast('Imported ' + r.keys + ' key' + (r.keys === 1 ? '' : 's') + (r.profiles > 1 ? ' across ' + r.profiles + ' pages' : '') + (r.dropped ? ' (' + r.dropped + ' didn’t fit)' : ''));
              el('profilepane').hidden = true;
            } else { toast(r.error || 'import failed', true); b.disabled = false; b.textContent = '⇩ ' + f.name; }
          });
        });
        row.appendChild(b);
        list.appendChild(row);
      });
    }
    var hint = document.createElement('div'); hint.className = 'pk-empty';
    hint.textContent = 'Profiles are separate key layouts. The knob cycles them. Importing a .streamDeckProfile again replaces what its last import created. Rename profiles from the PC editor on this page’s options.';
    list.appendChild(hint);
  }
  var addArm = null;
  el('addprofile').addEventListener('click', function () {
    var b = el('addprofile');
    if (addArm) {
      clearTimeout(addArm); addArm = null; b.textContent = '+ Profile';
      post('profile-add', {}).then(function (r) { if (r.ok) post('profile-select', { id: r.id }).then(function () { renderProfilePane(); }); });
      return;
    }
    b.textContent = 'Tap again to add';
    addArm = setTimeout(function () { addArm = null; b.textContent = '+ Profile'; }, 3000);
  });

  // ---- assignment overlay -----------------------------------------------
  var armAssign = null;
  function openAssign(c, r, k) {
    assignSlot = { col: c, row: r, key: k, profile: snap.activeProfile };
    armAssign = null;
    el('assigntitle').textContent = 'Key ' + (c + 1) + ',' + (r + 1) + (k ? ' — ' + shortName(k) : '');
    el('unassignbtn').hidden = !k;
    el('movebtn').hidden = !k;
    el('settingsbox').value = k ? JSON.stringify(k.settings || {}, null, 2) : '{}';
    el('assignmsg').textContent = k ? 'Tap an action twice to replace this key (its settings reset), or edit its settings below.' : 'Tap an action to assign it to this key.';
    var list = el('actionlist');
    list.innerHTML = '';
    // Built-in keys first: assignable without any plugin. Templates land in the settings box.
    var BUILTINS = [
      { b: 'hotkey', label: 'Hotkey', sub: 'press a key combo',
        tpl: { keys: [{ key: 'C', ctrl: true, shift: false, alt: false, win: false }] },
        msg: 'Set "key" (A–Z, 0–9, F1–F24, ENTER, TAB, UP, VOLUMEUP…) and the modifiers, then Save settings.' },
      { b: 'text', label: 'Text', sub: 'paste or type text',
        tpl: { text: 'Hello', typing: false, enter: false },
        msg: 'Set "text" (typing:true types it key-by-key; enter:true presses Enter after), then Save settings.' },
      { b: 'open', label: 'Open', sub: 'app, file, or URL',
        tpl: { target: 'C:\\Windows\\notepad.exe' },
        msg: 'Set "target" to a program, file, folder, or https:// URL, then Save settings.' },
      { b: 'website', label: 'Website', sub: 'open in browser',
        tpl: { url: 'https://example.com' },
        msg: 'Set "url", then Save settings.' },
    ];
    var lb = document.createElement('div'); lb.className = 'ov-label'; lb.textContent = 'Built-in keys';
    list.appendChild(lb);
    BUILTINS.forEach(function (bi) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'act';
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = bi.label; b.appendChild(g);
      var s = document.createElement('span'); s.className = 'sub'; s.textContent = bi.sub; b.appendChild(s);
      b.addEventListener('click', function () {
        if (assignSlot.key && armAssign !== b) {
          [].forEach.call(list.children, function (x) { x.classList.remove('arming'); });
          armAssign = b; b.classList.add('arming');
          el('assignmsg').textContent = 'Tap again to replace this key with a ' + bi.label + ' key.';
          return;
        }
        if (snap.activeProfile !== assignSlot.profile) { el('assignmsg').textContent = 'The active profile changed — close and try again.'; return; }
        armAssign = null;
        post('assign', { col: assignSlot.col, row: assignSlot.row, builtin: bi.b }).then(function (res) {
          if (!res.ok) { el('assignmsg').textContent = 'Failed: ' + (res.error || ''); return; }
          assignSlot.context = res.context; assignSlot.key = { context: res.context, builtin: bi.b, settings: res.settings || {} };
          el('unassignbtn').hidden = false; el('movebtn').hidden = false; el('copybtn').hidden = false;
          el('settingsbox').value = JSON.stringify(bi.tpl, null, 2);
          el('assignmsg').textContent = 'Assigned ✓ — ' + bi.msg;
        });
      });
      list.appendChild(b);
    });
    var lb2 = document.createElement('div'); lb2.className = 'ov-label'; lb2.textContent = 'Plugin actions';
    list.appendChild(lb2);
    var any = false;
    ((snap && snap.plugins) || []).forEach(function (p) {
      p.actions.forEach(function (a) {
        any = true;
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'act';
        var im = document.createElement('img'); actionIcon(p.id, a.icon, im); b.appendChild(im);
        var g = document.createElement('span'); g.className = 'grow'; g.textContent = a.name; b.appendChild(g);
        var s = document.createElement('span'); s.className = 'sub'; s.textContent = p.name; b.appendChild(s);
        b.addEventListener('click', function () {
          if (assignSlot.key && armAssign !== b) {
            [].forEach.call(list.children, function (x) { x.classList.remove('arming'); });
            armAssign = b; b.classList.add('arming');
            el('assignmsg').textContent = 'Tap again to replace this key with "' + a.name + '" (current settings will be erased).';
            return;
          }
          if (snap.activeProfile !== assignSlot.profile) { el('assignmsg').textContent = 'The active profile changed — close and try again.'; return; }
          armAssign = null;
          post('assign', { col: assignSlot.col, row: assignSlot.row, action: a.uuid, plugin: p.id }).then(function (res) {
            el('assignmsg').textContent = res.ok ? 'Assigned ✓' : ('Failed: ' + (res.error || ''));
            if (res.ok) { assignSlot.context = res.context; assignSlot.key = { context: res.context, settings: {} }; el('unassignbtn').hidden = false; el('movebtn').hidden = false; el('settingsbox').value = '{}'; }
          });
        });
        list.appendChild(b);
      });
    });
    if (!any) { var msg = document.createElement('div'); msg.className = 'pk-empty'; msg.textContent = 'No plugin actions yet — add plugins to your folder for more.'; list.appendChild(msg); }
    el('copybtn').hidden = !k;
    el('assign').hidden = false;
  }
  el('assignclose').addEventListener('click', function () { el('assign').hidden = true; assignSlot = null; });
  el('copybtn').addEventListener('click', function () {
    if (!assignSlot) return;
    var ctx = assignSlot.context || (assignSlot.key && assignSlot.key.context);
    if (!ctx) return;
    var list = el('actionlist');
    list.innerHTML = '';
    var lb = document.createElement('div'); lb.className = 'ov-label'; lb.textContent = 'Copy this key to…';
    list.appendChild(lb);
    ((snap && snap.profiles) || []).forEach(function (pr) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'act';
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = pr.name; b.appendChild(g);
      if (pr.id === snap.activeProfile) { var s = document.createElement('span'); s.className = 'sub'; s.textContent = 'this profile'; b.appendChild(s); }
      b.addEventListener('click', function () {
        post('copy', { context: ctx, profileId: pr.id }).then(function (r) {
          if (r.ok) { toast('Copied to "' + r.profile + '" (key ' + (parseInt(r.pos, 10) + 1) + ',' + ((r.pos.split(',')[1] | 0) + 1) + ')'); el('assign').hidden = true; assignSlot = null; }
          else toast(r.error || 'copy failed', true);
        });
      });
      list.appendChild(b);
    });
  });
  el('movebtn').addEventListener('click', function () {
    if (!assignSlot) return;
    movePending = { col: assignSlot.col, row: assignSlot.row };
    el('assign').hidden = true; assignSlot = null;
    toast('Tap a highlighted empty slot to move the key. Tap anything else to cancel.');
    render();
  });
  el('unassignbtn').addEventListener('click', function () {
    if (!assignSlot) return;
    post('unassign', { col: assignSlot.col, row: assignSlot.row }).then(function () { el('assign').hidden = true; assignSlot = null; });
  });
  el('settingssave').addEventListener('click', function () {
    if (!assignSlot) return;
    var ctx = assignSlot.context || (assignSlot.key && assignSlot.key.context);
    if (!ctx) { el('assignmsg').textContent = 'Assign an action first.'; return; }
    var parsed;
    try { parsed = JSON.parse(el('settingsbox').value || '{}'); } catch (e) { el('assignmsg').textContent = 'Not valid JSON.'; return; }
    post('settings-set', { context: ctx, settings: parsed }).then(function (res) {
      el('assignmsg').textContent = res.ok ? 'Settings saved ✓' : ('Failed: ' + (res.error || ''));
    });
  });

  // ---- plugins overlay ---------------------------------------------------
  el('pluginsbtn').addEventListener('click', function () { renderPluginsPane(); el('pluginspane').hidden = false; });
  el('pluginsclose').addEventListener('click', function () { el('pluginspane').hidden = true; });
  el('rescanbtn').addEventListener('click', function () {
    post('rescan', {}).then(function (j) {
      if (j && j.ok) {
        snap = j; render(); renderPluginsPane();
        toast('Rescanned: ' + j.plugins.length + ' plugin' + (j.plugins.length === 1 ? '' : 's')
          + ', ' + (j.importables || []).length + ' importable profile' + ((j.importables || []).length === 1 ? '' : 's')
          + (j.skipped.length ? ', ' + j.skipped.length + ' skipped' : ''));
      } else toast('Rescan failed', true);
    });
  });
  function renderPluginsPane() {
    el('panedot').className = el('hostdot').className;
    el('hoststatus').textContent = statusText();
    var list = el('pluginlist');
    list.innerHTML = '';
    var ps = (snap && snap.plugins) || [];
    var sk = (snap && snap.skipped) || [];
    if (!ps.length && !sk.length && !((snap && snap.importables) || []).length) {
      var m = document.createElement('div'); m.className = 'pk-empty';
      m.textContent = (snap && snap.folder ? 'Nothing in ' + snap.folder + ' yet. Drop *.sdPlugin folders, .streamDeckPlugin files, or .streamDeckProfile files there.' : 'Set this page’s "Plugins folder" option (and Save).') + ' Plugins are real programs that run on your PC — only use plugins you trust.';
      list.appendChild(m); return;
    }
    ps.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'plug';
      var head = document.createElement('div'); head.className = 'plughead';
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = p.name; head.appendChild(g);
      var st = document.createElement('span'); st.className = 'st ' + p.status; st.textContent = p.status; head.appendChild(st);
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Restart';
      b.addEventListener('click', function () { post('restart', { plugin: p.id }).then(function (r) { toast(r.ok ? 'Restarting ' + p.name + '…' : (r.error || 'restart failed'), !r.ok); }); });
      head.appendChild(b);
      d.appendChild(head);
      if (p.error) { var er = document.createElement('div'); er.className = 'plugerr'; er.textContent = p.error; d.appendChild(er); }
      (p.log || []).forEach(function (ln) { var lg = document.createElement('div'); lg.className = 'pluglog'; lg.textContent = ln; d.appendChild(lg); });
      list.appendChild(d);
    });
    sk.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'plug';
      var head = document.createElement('div'); head.className = 'plughead';
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = s.file; head.appendChild(g);
      var st = document.createElement('span'); st.className = 'st unsupported'; st.textContent = 'skipped'; head.appendChild(st);
      d.appendChild(head);
      var er = document.createElement('div'); er.className = 'plugerr'; er.textContent = s.reason; d.appendChild(er);
      list.appendChild(d);
    });
    // Profile files live in the same folder, so they belong in this pane too, importable in place.
    var imp = (snap && snap.importables) || [];
    if (imp.length) {
      var lbl = document.createElement('div'); lbl.className = 'ov-label'; lbl.style.marginTop = '16px';
      lbl.textContent = 'Profiles in this folder (' + imp.length + ')';
      list.appendChild(lbl);
      imp.forEach(function (f) {
        var d = document.createElement('div'); d.className = 'plug';
        var head = document.createElement('div'); head.className = 'plughead';
        var g = document.createElement('span'); g.className = 'grow'; g.textContent = f.name; head.appendChild(g);
        var st = document.createElement('span'); st.className = 'st'; st.textContent = 'profile'; head.appendChild(st);
        var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Import';
        b.addEventListener('click', function () {
          b.disabled = true; b.textContent = 'Importing…';
          post('import', { id: f.id }).then(function (r) {
            b.disabled = false; b.textContent = 'Import';
            if (r.ok) { toast('Imported ' + r.keys + ' key' + (r.keys === 1 ? '' : 's') + (r.profiles > 1 ? ' across ' + r.profiles + ' pages' : '')); el('pluginspane').hidden = true; }
            else toast(r.error || 'import failed', true);
          });
        });
        head.appendChild(b);
        d.appendChild(head);
        list.appendChild(d);
      });
    }
  }

  // ---- edit toggle -------------------------------------------------------
  el('editbtn').addEventListener('click', function () {
    editing = !editing;
    confirmRemoveId = null; movePending = null;
    render();
  });

  // ---- knob (generic drop-in capability) ---------------------------------
  window.oqKnob = function (ev) {
    if (!el('assign').hidden || !el('pluginspane').hidden || !el('profilepane').hidden || movePending || editing) return false;
    if (ev && ev.type === 'rotate' && snap && snap.profiles && snap.profiles.length > 1) {
      // cycle top-level profiles only; folder pages (children) are entered via their keys
      var tops = snap.profiles.filter(function (p) { return !p.child || p.id === snap.activeProfile; });
      var ids = tops.map(function (p) { return p.id; });
      if (ids.length < 2) return true;
      var i = ids.indexOf(snap.activeProfile);
      post('profile-select', { id: ids[(i + (ev.dir > 0 ? 1 : ids.length - 1)) % ids.length] });
      return true;
    }
    return false;
  };

  poll(0);
  window.addEventListener('resize', function () { if (snap) render(); });
})();
