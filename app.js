/* Deck Ledger - UI. Data lives in localStorage on this device only. */
(function () {
  'use strict';
  var E = window.Engine;
  var KEY = 'deckledger.v1';
  var app = document.getElementById('app');

  // ---------------------------------------------------------------- state
  function blank() { return { v: 1, seq: 1, rev: 0, settings: {}, players: {}, decks: {}, games: [] }; }
  function normalize(d) {
    var o = blank();
    if (!d || typeof d !== 'object') return o;
    o.seq = d.seq || 1; o.rev = d.rev || 0; o.settings = d.settings || {};
    o.players = d.players || {}; o.decks = d.decks || {}; o.games = d.games || [];
    Object.keys(o.decks).forEach(function (k) { o.decks[k].updates = o.decks[k].updates || []; delete o.decks[k].ref; });
    o.games.forEach(function (g) { g.feels = g.feels || []; });
    var mx = o.seq;
    o.games.forEach(function (g) { if (g.seq >= mx) mx = g.seq + 1; });
    Object.keys(o.decks).forEach(function (k) { o.decks[k].updates.forEach(function (u) { if (u.seq >= mx) mx = u.seq + 1; }); });
    o.seq = mx;
    return o;
  }
  function load() {
    try { var raw = localStorage.getItem(KEY); if (raw) return normalize(JSON.parse(raw)); } catch (e) { /* fall through */ }
    return blank();
  }
  var db = load();
  var fitCache = null;
  function F() { return fitCache || (fitCache = E.fit(db)); }
  function save() {
    db.rev++; fitCache = null;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Could not save: storage is full or blocked'); }
  }
  function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  function nextSeq() { return db.seq++; }
  function today() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function S() { return E.settingsOf(db); }

  var route = { name: 'decks' }, stack = [], sheet = null, form = {}, draft = null, feelSel = {};
  var ui = { deckFilter: null };

  // ---------------------------------------------------------------- helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function sgn(x) { return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2); }
  function myId() { var m = db.settings.me; return m && db.players[m] ? m : null; }
  function pName(id) { var p = db.players[id]; return id === 'guest' ? 'Guest' : p ? (p.anon ? 'Guest' : p.name) : '?'; }
  function dName(d) {
    if (d && typeof d === 'object') return 'Unknown deck';
    var x = db.decks[d]; return x ? (x.anon ? 'Unknown deck' : x.name) : '?';
  }
  function conf(sd) { return sd < 0.3 ? 'solid' : sd < 0.5 ? 'fair' : sd < 0.75 ? 'rough' : 'mostly a guess'; }
  function toast(msg) {
    var old = document.querySelector('.toast'); if (old) old.remove();
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }
  function rangeBar(mean, sd, big) {
    var lo = clamp((mean - sd - 1) / 5 * 100, 0, 100), hi = clamp((mean + sd - 1) / 5 * 100, 0, 100), pos = clamp((mean - 1) / 5 * 100, 0, 100);
    return '<div class="range' + (big ? ' big' : '') + '"><div class="band" style="left:' + lo + '%;width:' + Math.max(hi - lo, 1) + '%"></div><div class="dot" style="left:' + pos + '%"></div></div>' +
      (big ? '<div class="scale"><span>B1</span><span>B2</span><span>B3</span><span>B4</span><span>B5</span></div>' : '');
  }
  function lastUsed() {
    var lp = {}, ld = {}, pil = {};
    db.games.forEach(function (g) {
      g.seats.forEach(function (s) {
        lp[s.p] = Math.max(lp[s.p] || 0, g.seq); ld[s.d] = Math.max(ld[s.d] || 0, g.seq);
        pil[s.p + '|' + s.d] = Math.max(pil[s.p + '|' + s.d] || 0, g.seq);
      });
    });
    return { p: lp, d: ld, pil: pil };
  }
  function gkey(g) { return E.keyOf(g.date, g.seq); }
  function seedChips() {
    var sb = form.sb || 3, st = form.st == null ? 1 : form.st;
    var h = '<div class="chips">';
    for (var b = 1; b <= 5; b++) h += '<button class="chip' + (b === sb ? ' on' : '') + '" data-act="sb" data-v="' + b + '">Bracket ' + b + '</button>';
    h += '</div><div class="chips">';
    ['Low', 'Mid', 'High'].forEach(function (t, i) { h += '<button class="chip' + (i === st ? ' on' : '') + '" data-act="st" data-v="' + i + '">' + t + '</button>'; });
    return h + '</div>';
  }
  function seedFromForm() { return E.seedValue(form.sb || 3, form.st == null ? 1 : form.st); }
  function seedToForm(seed) { form.sb = clamp(Math.floor(seed), 1, 5); form.st = E.tierOf(seed); }


  var SKILL_LABELS = [['weak', 'Weaker'], ['avg', 'Typical'], ['strong', 'Stronger'], ['very', 'Much stronger']];
  function skillBlock() {
    return '<label>Pilot skill, compared with the typical player at your table</label><div class="seg">' + SKILL_LABELS.map(function (c) {
      return '<button class="' + ((form.skill || 'avg') === c[0] ? 'on' : '') + '" data-act="setSkill" data-v="' + c[0] + '">' + c[1] + '</button>'; }).join('') + '</div>' +
      '<label>How sure are you?</label><div class="seg">' + CONF_LABELS.map(function (c) {
      return '<button class="' + ((form.skillConf || 'fair') === c[0] ? 'on' : '') + '" data-act="setSkillConf" data-v="' + c[0] + '">' + c[1] + '</button>'; }).join('') + '</div>' +
      '<p class="small muted">A starting point only. "Typical" means the average pilot in your group, so rate people against each other rather than against you.</p>';
  }
  function applySkill(pl) { pl.skill = form.skill || 'avg'; pl.skillConf = form.skillConf || 'fair'; }
  function skillText(p) { var x = SKILL_LABELS.filter(function (l) { return l[0] === (p.skill || 'avg'); })[0]; return x[1].toLowerCase(); }

  var CONF_LABELS = [['rough', 'Rough guess'], ['fair', 'Fairly sure'], ['solid', 'Know it well']];
  function confText(c) { var x = CONF_LABELS.filter(function (l) { return l[0] === (c || 'fair'); })[0]; return x[1].toLowerCase(); }
  function seedBlock() {
    return '<label>How sure are you about this estimate?</label><div class="seg">' + CONF_LABELS.map(function (c) {
      return '<button class="' + ((form.conf || 'fair') === c[0] ? 'on' : '') + '" data-act="setConf" data-v="' + c[0] + '">' + c[1] + '</button>'; }).join('') + '</div>' +
      '<label>Your best guess at its strength</label>' + seedChips() + '<p class="small muted">Starting estimate: <b>' + E.labelFor(seedFromForm()) + '</b>.</p>';
  }
  function readSeed() { return { seed: seedFromForm(), conf: form.conf || 'fair' }; }
  function applySeed(deck, sd) { deck.seed = sd.seed; deck.conf = sd.conf; delete deck.ref; }

  // ---------------------------------------------------------------- navigation
  function nav(name, params) { stack.push(route); route = Object.assign({ name: name }, params || {}); form = {}; sheet = null; render(true); }
  function back() { route = stack.pop() || { name: 'decks' }; form = {}; sheet = null; render(true); }
  function tab(name) {
    stack = []; sheet = null; form = {};
    if (name === 'log') { startLog(); return; }
    route = { name: name }; render(true);
  }
  var TAB_OF = { decks: 'decks', deck: 'decks', newdeck: 'decks', editdeck: 'decks', update: 'decks', review: 'decks',
    players: 'players', player: 'players', newplayer: 'players', editplayer: 'players', guests: 'players', promote: 'players',
    log: 'log', feel: 'log', history: 'history', more: 'more', welcome: 'more' };
  var ICONS = {
    decks: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    players: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14.2c2.3.2 4 2 4 4.8"/>',
    log: '<path d="M12 5v14M5 12h14"/>',
    history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    more: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'
  };
  function tabbar() {
    var cur = TAB_OF[route.name];
    var items = [['decks', 'Decks'], ['players', 'Players'], ['log', 'Log game'], ['history', 'History'], ['more', 'More']];
    return '<nav class="tabs">' + items.map(function (it) {
      var on = cur === it[0] ? ' on' : '';
      if (it[0] === 'log') return '<button class="plus' + on + '" data-act="tab" data-v="log" aria-label="Log game"><span class="dot"><svg viewBox="0 0 24 24">' + ICONS.log + '</svg></span><span>Log game</span></button>';
      return '<button class="' + on.trim() + '" data-act="tab" data-v="' + it[0] + '"><svg viewBox="0 0 24 24">' + ICONS[it[0]] + '</svg><span>' + it[1] + '</span></button>';
    }).join('') + '</nav>';
  }

  // ---------------------------------------------------------------- views
  var V = {};

  V.welcome = function () {
    return { title: 'Deck Ledger', body:
      '<p>Track Commander games and learn how strong your decks really are, from results rather than gut feeling.</p>' +
      '<p class="muted small">Everything stays on this device. Nothing is uploaded.</p>' +
      '<label>Your name</label><input type="text" data-f="name" data-autofocus value="' + esc(form.name || '') + '" placeholder="e.g. Mikey" autocomplete="off">' + skillBlock() +
      '<button class="btn" data-act="createMe">Get started</button>' +
      '<button class="btn sec" data-act="pickImport">I have a backup to import</button>' + importInput() };
  };

  V.decks = function () {
    var res = F(), me = myId();
    var filt = ui.deckFilter || (me ? 'mine' : 'all');
    var list = Object.keys(db.decks).map(function (k) { return db.decks[k]; }).filter(function (d) { return !d.anon; });
    var total = list.length;
    if (filt === 'mine' && me) list = list.filter(function (d) { return d.ownerId === me; });
    list.sort(function (a, b) { return (a.retired ? 1 : 0) - (b.retired ? 1 : 0) || res.deck[b.id].mean - res.deck[a.id].mean; });
    var rank = 0;
    var cards = list.map(function (d) {
      var r = res.deck[d.id];
      if (!d.retired) rank++;
      return '<button class="card' + (d.retired ? ' dim' : '') + '" data-act="open" data-name="deck" data-id="' + d.id + '">' +
        '<div class="row"><div class="rank">' + (d.retired ? '' : rank) + '</div><div class="grow"><div class="name">' + esc(d.name) + (d.retired ? '<span class="pill">retired</span>' : '') + '</div>' +
        '<div class="sub">' + esc(d.ownerId ? pName(d.ownerId) : 'No owner') + ' · ' + r.wins + ' won of ' + r.games + '</div></div>' +
        '<div class="rate"><b>' + E.labelFor(r.mean) + '</b><span>' + r.mean.toFixed(2) + ' ±' + r.sd.toFixed(1) + '</span></div></div>' +
        rangeBar(r.mean, r.sd) + '</button>';
    }).join('');
    var chips = me ? '<div class="chips"><button class="chip' + (filt === 'mine' ? ' on' : '') + '" data-act="deckFilter" data-v="mine">My decks</button><button class="chip' + (filt === 'all' ? ' on' : '') + '" data-act="deckFilter" data-v="all">Everyone’s</button></div>' : '';
    var pending = Object.keys(db.decks).filter(function (k) { var d = db.decks[k]; return !d.anon && !d.retired && d.needsSeed; }).length;
    var banner = pending ? '<button class="card" data-act="open" data-name="review"><div class="row"><div class="grow"><div class="name">Review estimates</div><div class="sub">' + pending + ' deck' + (pending === 1 ? '' : 's') + ' still using a placeholder strength</div></div><span class="pill accent">to do</span></div></button>' : '';
    var empty = !cards ? '<div class="empty">' + (total ? 'No decks here yet.' : 'No decks yet. Add your first deck, then log some games.') + '</div>' : '';
    return { title: 'Decks', right: '<button class="icon" data-act="open" data-name="newdeck" aria-label="New deck">+</button>',
      body: chips + banner + cards + empty + '<button class="btn sec" data-act="open" data-name="newdeck">New deck</button>' +
        '<p class="muted small">Ratings are learned from results. The bar shows the estimate and how sure the app is: a narrow bar means more evidence.</p>' };
  };

  V.deck = function () {
    var d = db.decks[route.id]; if (!d) return notFound();
    var res = F(), r = res.deck[d.id], ups = E.sortedUpdates(d);
    var vers = ups.map(function (u, i) {
      var v = r.versions[i + 1];
      return '<div class="card"><div class="row"><div class="grow"><div class="name">' + esc(u.date) + '</div><div class="sub">' + u.cards + ' card' + (u.cards === 1 ? '' : 's') + ' changed · ' + (u.goal != null ? 'aiming for ' + E.labelFor(u.goal) : u.dir === 'up' ? 'aiming stronger' : u.dir === 'down' ? 'aiming weaker' : 'same level') + '</div></div>' +
        '<div class="rate"><b>' + E.labelFor(v.mean) + '</b><span>' + v.mean.toFixed(2) + ' ±' + v.sd.toFixed(1) + '</span></div></div></div>';
    }).reverse().join('');
    var v0 = r.versions[0];
    var recent = db.games.filter(function (g) { return g.seats.some(function (s) { return s.d === d.id; }); })
      .sort(function (a, b) { return gkey(a) < gkey(b) ? 1 : -1; }).slice(0, 6).map(function (g) {
        var i = g.seats.findIndex(function (s) { return s.d === d.id; }), won = g.winner === i;
        var opp = g.seats.filter(function (s, j) { return j !== i; }).map(function (s) { return esc(pName(s.p)); }).join(', ');
        return '<div class="row small hist" style="padding:6px 0"><span style="width:44px" class="' + (won ? 'w' : 'muted') + '">' + (won ? 'Won' : 'Lost') + '</span><span class="grow muted">vs ' + opp + '</span><span class="muted">' + esc(g.date) + '</span></div>';
      }).join('');
    return { title: esc(d.name), back: true, body:
      '<div class="big-label">' + E.labelFor(r.mean) + '</div>' +
      '<div class="muted">' + r.mean.toFixed(2) + ' ±' + r.sd.toFixed(2) + ' · confidence: ' + conf(r.sd) + '</div>' +
      '<div style="margin-top:10px">' + rangeBar(r.mean, r.sd, true) + '</div>' +
      '<div class="stats"><div class="stat"><b>' + r.games + '</b><span>games</span></div><div class="stat"><b>' + r.wins + '</b><span>wins</span></div><div class="stat"><b>' + (r.games ? Math.round(100 * r.wins / r.games) + '%' : '–') + '</b><span>win rate</span></div></div>' +
      '<p class="small muted">Owner: ' + (d.ownerId ? '<button class="small" style="color:var(--accent)" data-act="open" data-name="player" data-id="' + d.ownerId + '">' + esc(pName(d.ownerId)) + '</button>' : 'none') + '</p>' +
      '<button class="btn" data-act="open" data-name="update" data-id="' + d.id + '">Log a deck update</button>' +
      '<h2>Versions</h2>' + vers +
      '<div class="card"><div class="row"><div class="grow"><div class="name">Starting estimate</div><div class="sub">' + 'Your seed: ' + E.labelFor(d.seed) + ' \u00b7 ' + confText(d.conf) + '</div></div><div class="rate"><b>' + E.labelFor(v0.mean) + '</b><span>' + v0.mean.toFixed(2) + ' ±' + v0.sd.toFixed(1) + '</span></div></div></div>' +
      (recent ? '<h2>Recent games</h2><div class="card">' + recent + '</div>' : '') +
      '<button class="btn sec" data-act="open" data-name="editdeck" data-id="' + d.id + '">Edit deck</button>' };
  };

  function updateShift(cards, dir, goal, est, s) {
    if (goal != null) return (goal - est) * Math.min(s.goalMaxFrac, cards / s.goalFullCards);
    var d = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
    return d * Math.min(cards * s.shiftPerCard, s.shiftCap);
  }

  function updateNote(d) {
    var s = S(), est = F().deck[d.id].mean;
    var cards = Math.max(1, parseInt(form.cards, 10) || 1), goal = form.goalOn ? seedFromForm() : null;
    var nudge = updateShift(cards, form.dir, goal, est, s), vol = s.volBase + s.volPerCard * cards;
    return 'Rating nudge: <b>' + (nudge >= 0 ? '+' : '−') + Math.abs(nudge).toFixed(2) + '</b> brackets' + (goal != null ? ' (partway to ' + E.labelFor(goal) + '; an intention is not a result, so games decide the rest)' : '') + '. Added uncertainty: <b>±' + vol.toFixed(2) + '</b>.';
  }

  V.update = function () {
    var d = db.decks[route.id]; if (!d) return notFound();
    var s = S(), est = F().deck[d.id].mean;
    if (form.cards == null) { form.cards = 10; form.dir = 'same'; form.date = today(); form.goalOn = false; seedToForm(est); }
    var intent = form.goalOn
      ? '<label>Where are you aiming for it to land?</label>' + seedChips() +
        '<button class="btn sec small" data-act="toggleGoal">Never mind, just say stronger or weaker</button>'
      : '<label>What was the intent?</label><div class="seg">' +
        [['same', 'Same level'], ['up', 'Stronger'], ['down', 'Weaker']].map(function (o) { return '<button class="' + (form.dir === o[0] ? 'on' : '') + '" data-act="setDir" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>' +
        '<button class="btn sec small" data-act="toggleGoal">Set a target level instead</button>';
    return { title: 'Deck update', back: true, body:
      '<p class="muted">' + esc(d.name) + ' is currently <b>' + E.labelFor(est) + '</b>. Most tuning keeps a deck at the same level, so by default the rating barely moves and the app just becomes a little less sure until new games come in.</p>' +
      '<label>Cards changed</label><input type="number" inputmode="numeric" min="1" max="99" data-f="cards" value="' + esc(form.cards) + '">' + intent +
      '<label>Date</label><input type="date" data-f="date" value="' + esc(form.date) + '">' +
      '<div class="note" id="upnote">' + updateNote(d) + '</div>' +
      '<button class="btn" data-act="saveUpdate" data-id="' + d.id + '">Save update</button>' };
  };

  V.newdeck = function () {
    if (form.sb == null) { form.sb = 3; form.st = 1; form.owner = route.owner || myId() || ''; form.name = ''; form.conf = 'fair'; }
    var players = Object.keys(db.players).map(function (k) { return db.players[k]; }).filter(function (p) { return !p.anon && !p.retired; });
    if (!players.length) return { title: 'New deck', back: true, body: '<div class="empty">Add a player first.</div><button class="btn" data-act="open" data-name="newplayer">New player</button>' };
    return { title: 'New deck', back: true, body:
      '<label>Deck name</label><input type="text" data-f="name" data-autofocus value="' + esc(form.name) + '" placeholder="Commander or nickname" autocomplete="off">' +
      '<label>Owner</label><select data-f="owner">' + players.map(function (p) { return '<option value="' + p.id + '"' + (p.id === form.owner ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>' +
      seedBlock(null) +
      '<p class="small muted">It is only a starting point; results override it over time, faster the less sure you are.</p>' +
      '<button class="btn" data-act="saveNewDeck">Add deck</button>' };
  };

  V.editdeck = function () {
    var d = db.decks[route.id]; if (!d) return notFound();
    if (form.name == null) { form.name = d.name; form.owner = d.ownerId || ''; seedToForm(d.seed); form.conf = d.conf || 'fair'; }
    var players = Object.keys(db.players).map(function (k) { return db.players[k]; }).filter(function (p) { return !p.anon; });
    var games = F().deck[d.id].games;
    return { title: 'Edit deck', back: true, body:
      '<label>Deck name</label><input type="text" data-f="name" value="' + esc(form.name) + '" autocomplete="off">' +
      '<label>Owner</label><select data-f="owner"><option value="">No owner</option>' + players.map(function (p) { return '<option value="' + p.id + '"' + (p.id === form.owner ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>' +
      seedBlock(d.id) +
      '<p class="small muted">Changing this only changes where the rating starts from. Game results are kept.</p>' +
      '<button class="btn" data-act="saveEditDeck" data-id="' + d.id + '">Save</button>' +
      '<button class="btn sec" data-act="toggleRetire" data-kind="deck" data-id="' + d.id + '">' + (d.retired ? 'Bring back from retirement' : 'Retire deck (hide from pickers)') + '</button>' +
      (games === 0 ? '<button class="btn danger" data-act="deleteDeck" data-id="' + d.id + '">Delete deck</button>' : '<p class="small muted">This deck has games logged, so it can be retired but not deleted.</p>') };
  };

  V.players = function () {
    var res = F();
    var list = Object.keys(db.players).map(function (k) { return db.players[k]; }).filter(function (p) { return !p.anon; });
    list.sort(function (a, b) { return (a.retired ? 1 : 0) - (b.retired ? 1 : 0) || res.player[b.id].skill - res.player[a.id].skill; });
    var guests = Object.keys(db.players).filter(function (k) { return db.players[k].anon; }).length + Object.keys(db.decks).filter(function (k) { return db.decks[k].anon; }).length;
    var cards = list.map(function (p) {
      var r = res.player[p.id], n = Object.keys(db.decks).filter(function (k) { return db.decks[k].ownerId === p.id && !db.decks[k].anon; }).length;
      return '<button class="card' + (p.retired ? ' dim' : '') + '" data-act="open" data-name="player" data-id="' + p.id + '"><div class="row"><div class="grow"><div class="name">' + esc(p.name) + (p.id === myId() ? '<span class="pill accent">you</span>' : '') + (p.retired ? '<span class="pill">retired</span>' : '') + '</div>' +
        '<div class="sub">' + n + ' deck' + (n === 1 ? '' : 's') + ' · ' + r.wins + ' won of ' + r.games + '</div></div>' +
        '<div class="rate"><b>' + sgn(r.skill) + '</b><span>skill ±' + r.sd.toFixed(1) + '</span></div></div></button>';
    }).join('');
    return { title: 'Players', right: '<button class="icon" data-act="open" data-name="newplayer" aria-label="New player">+</button>', body:
      (cards || '<div class="empty">No players yet.</div>') +
      '<button class="btn sec" data-act="open" data-name="newplayer">New player</button>' +
      (guests ? '<button class="btn sec" data-act="open" data-name="guests">Guests and unknown decks (' + guests + ')</button>' : '') +
      '<p class="muted small">Skill is how much better (+) or worse (−) someone does than their decks alone would predict, in bracket steps. It needs a player to have used several decks to be pinned down.</p>' };
  };

  V.player = function () {
    var p = db.players[route.id]; if (!p) return notFound();
    var res = F(), r = res.player[p.id];
    var decks = Object.keys(db.decks).map(function (k) { return db.decks[k]; }).filter(function (d) { return d.ownerId === p.id && !d.anon; })
      .sort(function (a, b) { return res.deck[b.id].mean - res.deck[a.id].mean; });
    return { title: esc(p.name), back: true, body:
      '<div class="big-label">' + sgn(r.skill) + '</div><div class="muted">skill ±' + r.sd.toFixed(2) + ' brackets · confidence: ' + conf(r.sd) + '</div>' + '<div class="small muted">Starting estimate: ' + skillText(p) + ' than typical (' + confText(p.skillConf) + ')</div>' +
      '<div class="stats"><div class="stat"><b>' + r.games + '</b><span>games</span></div><div class="stat"><b>' + r.wins + '</b><span>wins</span></div><div class="stat"><b>' + decks.length + '</b><span>decks</span></div></div>' +
      '<h2>Decks</h2>' + (decks.map(function (d) {
        var dr = res.deck[d.id];
        return '<button class="card' + (d.retired ? ' dim' : '') + '" data-act="open" data-name="deck" data-id="' + d.id + '"><div class="row"><div class="grow name">' + esc(d.name) + '</div><div class="rate"><b>' + E.labelFor(dr.mean) + '</b><span>' + dr.mean.toFixed(2) + '</span></div></div></button>';
      }).join('') || '<div class="muted small">No decks yet.</div>') +
      '<button class="btn" data-act="open" data-name="newdeck" data-owner="' + p.id + '">Add a deck for ' + esc(p.name) + '</button>' +
      '<button class="btn sec" data-act="open" data-name="editplayer" data-id="' + p.id + '">Edit player</button>' };
  };

  V.newplayer = function () {
    return { title: 'New player', back: true, body:
      '<label>Name</label><input type="text" data-f="name" data-autofocus value="' + esc(form.name || '') + '" autocomplete="off">' + skillBlock() +
      '<button class="btn" data-act="saveNewPlayer">Add player</button>' };
  };

  V.editplayer = function () {
    var p = db.players[route.id]; if (!p) return notFound();
    if (form.name == null) { form.name = p.name; form.skill = p.skill || 'avg'; form.skillConf = p.skillConf || 'fair'; }
    var owned = Object.keys(db.decks).some(function (k) { return db.decks[k].ownerId === p.id; });
    var games = F().player[p.id].games;
    return { title: 'Edit player', back: true, body:
      '<label>Name</label><input type="text" data-f="name" value="' + esc(form.name) + '" autocomplete="off">' + skillBlock() +
      '<button class="btn" data-act="saveEditPlayer" data-id="' + p.id + '">Save</button>' +
      (p.id === myId() ? '' : '<button class="btn sec" data-act="makeMe" data-id="' + p.id + '">This is me</button>') +
      '<button class="btn sec" data-act="toggleRetire" data-kind="player" data-id="' + p.id + '">' + (p.retired ? 'Bring back from retirement' : 'Retire player (hide from pickers)') + '</button>' +
      (!games && !owned ? '<button class="btn danger" data-act="deletePlayer" data-id="' + p.id + '">Delete player</button>' : '') };
  };

  V.guests = function () {
    var res = F();
    var gp = Object.keys(db.players).map(function (k) { return db.players[k]; }).filter(function (p) { return p.anon; });
    var gd = Object.keys(db.decks).map(function (k) { return db.decks[k]; }).filter(function (d) { return d.anon; });
    function first(test) { var g = db.games.filter(test).sort(function (a, b) { return gkey(a) < gkey(b) ? -1 : 1; })[0]; return g ? g.date : ''; }
    var pl = gp.map(function (p) {
      return '<div class="card"><div class="row"><div class="grow"><div class="name">Guest</div><div class="sub">first seen ' + esc(first(function (g) { return g.seats.some(function (s) { return s.p === p.id; }); })) + ' · ' + res.player[p.id].games + ' game' + '</div></div>' +
        '<button class="btn small" style="margin:0" data-act="open" data-name="promote" data-kind="player" data-id="' + p.id + '">Name them</button></div></div>';
    }).join('');
    var dl = gd.map(function (d) {
      return '<div class="card"><div class="row"><div class="grow"><div class="name">Unknown deck <span class="pill">' + E.labelFor(d.seed) + '</span></div><div class="sub">' + (d.ownerId ? esc(pName(d.ownerId)) + ' · ' : '') + esc(first(function (g) { return g.seats.some(function (s) { return s.d === d.id; }); })) + '</div></div>' +
        '<button class="btn small" style="margin:0" data-act="open" data-name="promote" data-kind="deck" data-id="' + d.id + '">Name it</button></div></div>';
    }).join('');
    return { title: 'Guests', back: true, body:
      '<p class="muted small">Guests and unknown decks are not rated; they just use your estimate. Name one to start tracking it, and its earlier games count.</p>' +
      (pl ? '<h2>Guest players</h2>' + pl : '') + (dl ? '<h2>Unknown decks</h2>' + dl : '') + (!pl && !dl ? '<div class="empty">None yet.</div>' : '') };
  };

  V.promote = function () {
    var kind = route.kind, ent = kind === 'player' ? db.players[route.id] : db.decks[route.id]; if (!ent) return notFound();
    if (form.name == null) { form.name = ''; form.owner = (kind === 'deck' && ent.ownerId && db.players[ent.ownerId] && !db.players[ent.ownerId].anon) ? ent.ownerId : (myId() || ''); }
    var players = Object.keys(db.players).map(function (k) { return db.players[k]; }).filter(function (p) { return !p.anon && !p.retired; });
    return { title: kind === 'player' ? 'Name this player' : 'Name this deck', back: true, body:
      '<label>Name</label><input type="text" data-f="name" data-autofocus value="' + esc(form.name) + '" autocomplete="off">' +
      (kind === 'player' ? skillBlock() : '') +
      (kind === 'deck' ? '<label>Owner</label><select data-f="owner">' + players.map(function (p) { return '<option value="' + p.id + '"' + (p.id === form.owner ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>' : '') +
      '<button class="btn" data-act="savePromote" data-kind="' + kind + '" data-id="' + route.id + '">Save</button>' };
  };


  // ---------------------------------------------------------------- review estimates
  function reviewQueue() {
    var res = F(), me = myId(), f = ui.reviewFilter || 'mine';
    var sk = ui.reviewSkipped || {};
    var list = Object.keys(db.decks).map(function (k) { return db.decks[k]; }).filter(function (d) { return !d.anon && !d.retired && d.needsSeed && !sk[d.id]; });
    if (f === 'mine' && me) list = list.filter(function (d) { return d.ownerId === me; });
    if (f === 'seen5') list = list.filter(function (d) { return res.deck[d.id].games >= 5; });
    list.sort(function (a, b) { return res.deck[b.id].games - res.deck[a.id].games || a.name.localeCompare(b.name); });
    return list;
  }
  function reviewCount(f) { var keep = ui.reviewFilter; ui.reviewFilter = f; var n = reviewQueue().length; ui.reviewFilter = keep; return n; }

  V.review = function () {
    var res = F(), me = myId(), q = reviewQueue(), total = Object.keys(db.decks).filter(function (k) { var d = db.decks[k]; return !d.anon && !d.retired && d.needsSeed; }).length;
    var f = ui.reviewFilter || (me ? 'mine' : 'all');
    var chips = '<div class="chips">' + [['mine', 'My decks'], ['seen5', 'Seen 5+ times'], ['all', 'All']].map(function (o) {
      return '<button class="chip' + (f === o[0] ? ' on' : '') + '" data-act="reviewFilter" data-v="' + o[0] + '">' + o[1] + ' (' + reviewCount(o[0]) + ')</button>'; }).join('') + '</div>';
    if (!q.length) return { title: 'Review estimates', back: true, body: chips + '<div class="empty">' + (total ? 'Nothing left in this group.' : 'All decks have estimates.') + '</div>' + (total ? '<p class="small muted">' + total + ' deck' + (total === 1 ? '' : 's') + ' still unestimated in other groups. Unreviewed decks keep a rough B3-mid placeholder, which is fine for opponents you rarely see.</p>' : '') };
    var d = q[0], r = res.deck[d.id];
    if (form.deckId !== d.id) { form = { deckId: d.id, sb: 3, st: 1, conf: 'rough' }; }
    return { title: 'Review estimates', back: true, body: chips +
      '<p class="small muted">' + q.length + ' to go in this group. Go from memory: what you thought of the deck before seeing any results.</p>' +
      '<div class="card"><div class="name" style="font-size:18px">' + esc(d.name) + '</div><div class="sub">' + esc(d.ownerId ? pName(d.ownerId) : 'No owner') + ' · ' + r.games + ' game' + (r.games === 1 ? '' : 's') + ' logged</div></div>' +
      seedBlock() +
      '<button class="btn" data-act="reviewSave" data-id="' + d.id + '">Save and next</button>' +
      '<div class="row"><button class="btn sec small" data-act="reviewSkip" data-id="' + d.id + '">Skip for now</button><button class="btn sec small" data-act="reviewLeave" data-id="' + d.id + '">Leave as placeholder</button></div>' };
  };

  // ---------------------------------------------------------------- logging a game
  function startLog() {
    var me = myId(), d0 = null;
    if (me) {
      var lg = db.games.filter(function (g) { return g.seats.some(function (s) { return s.p === me; }); }).sort(function (a, b) { return gkey(a) < gkey(b) ? 1 : -1; })[0];
      if (lg) { var s = lg.seats.find(function (x) { return x.p === me; }); if (db.decks[s.d] && !db.decks[s.d].anon && !db.decks[s.d].retired) d0 = s.d; }
    }
    draft = { date: today(), step: 1, winner: null, seats: [0, 1, 2, 3].map(function (i) { return { p: i === 0 && me ? me : null, d: i === 0 ? d0 : null }; }) };
    stack = []; sheet = null; form = {}; route = { name: 'log' }; render(true);
  }
  function seatReady(s) { return !!(s.p && s.d); }
  function seatLabelP(s) { return s.p ? pName(s.p) : null; }
  function seatLabelD(s) { return s.d ? (typeof s.d === 'object' ? 'Unknown (' + E.labelFor(s.d.anonSeed) + ')' : dName(s.d)) : null; }
  function draftPredict() {
    var res = F(), k = res.S.kappa;
    var st = draft.seats.map(function (s) {
      var sk = s.p && res.player[s.p] && !res.player[s.p].anon ? res.player[s.p].skill : 0;
      var dk = typeof s.d === 'object' ? s.d.anonSeed : (res.deck[s.d] && !res.deck[s.d].anon ? res.deck[s.d].mean : db.decks[s.d].seed);
      return (sk + dk - 3) * k;
    });
    var mx = Math.max.apply(null, st), Z = 0, ex = st.map(function (x) { var e = Math.exp(x - mx); Z += e; return e; });
    return ex.map(function (e) { return e / Z; });
  }

  V.log = function () {
    if (!draft) startLog();
    if (draft.step === 2) return logWinner();
    var hasLast = db.games.length > 0;
    var seats = draft.seats.map(function (s, i) {
      var pl = seatLabelP(s), dk = seatLabelD(s);
      return '<div class="card seat"><div class="t">Seat ' + (i + 1) + '</div>' +
        (draft.seats.length > 2 ? '<button class="x" data-act="rmSeat" data-i="' + i + '" aria-label="Remove seat">×</button>' : '') +
        '<button class="pick" data-act="pickP" data-i="' + i + '"><span>Player</span><span class="' + (pl ? 'v' : 'ph') + '">' + esc(pl || 'Choose') + '</span></button>' +
        '<button class="pick" data-act="pickD" data-i="' + i + '"><span>Deck</span><span class="' + (dk ? 'v' : 'ph') + '">' + esc(dk || 'Choose') + '</span></button></div>';
    }).join('');
    var ready = draft.seats.length >= 2 && draft.seats.every(seatReady);
    return { title: 'Log a game', body:
      (hasLast ? '<div class="chips"><button class="chip" data-act="repeatPod">Same pod as last game</button></div>' : '') + seats +
      (draft.seats.length < 6 ? '<button class="btn sec" data-act="addSeat">Add a seat</button>' : '') +
      '<label>Date</label><input type="date" data-dr="date" value="' + esc(draft.date) + '">' +
      '<button class="btn" data-act="toWinner"' + (ready ? '' : ' disabled') + '>Next: who won?</button>' +
      (ready ? '' : '<p class="muted small">Pick a player and deck for every seat (guests and unknown decks are fine). Remove empty seats with ×.</p>') };
  };

  function logWinner() {
    var pr = draftPredict();
    var cards = draft.seats.map(function (s, i) {
      return '<button class="card winner-card' + (draft.winner === i ? ' on' : '') + '" data-act="win" data-i="' + i + '"><div class="row"><div class="grow"><div class="name">' + esc(seatLabelP(s)) + '</div><div class="sub">' + esc(seatLabelD(s)) + '</div></div><div class="pct">' + Math.round(pr[i] * 100) + '%</div></div></button>';
    }).join('');
    return { title: 'Who won?', back: true, body:
      '<p class="muted small">Percentages are the app’s pre-game win chances. Tap the winner.</p>' + cards +
      '<button class="btn" data-act="saveGame"' + (draft.winner == null ? ' disabled' : '') + '>Save game</button>' };
  }

  V.feel = function () {
    var res = F();
    var rows = route.items.map(function (id) {
      var r = res.deck[id], sel = feelSel[id];
      return '<div class="card"><div class="row"><div class="grow"><div class="name">' + esc(db.decks[id].name) + '</div><div class="sub">' + esc(pName(db.decks[id].ownerId)) + '</div></div><div class="rate"><b>' + E.labelFor(r.mean) + '</b><span>±' + r.sd.toFixed(1) + '</span></div></div>' +
        '<div class="feelrow">' + [[-1, 'Weaker'], [0, 'As expected'], [1, 'Stronger']].map(function (o) { return '<button class="' + (sel === o[0] ? 'on' : '') + '" data-act="feelSet" data-d="' + id + '" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div></div>';
    }).join('');
    return { title: 'Game saved', body:
      '<p class="muted">Optional: how did these decks feel compared with their rating? Only decks you pilot, or that have turned up a few times and are still uncertain, are listed. A tap counts as a light nudge.</p>' + rows +
      '<button class="btn" data-act="feelDone">Done</button>' };
  };

  V.history = function () {
    var res = F();
    var list = db.games.slice().sort(function (a, b) { return gkey(a) < gkey(b) ? 1 : -1; });
    var h = list.map(function (g) {
      return '<div class="card hist"><div class="row"><div class="grow muted small">' + esc(g.date) + '</div><button class="del" data-act="delGame" data-id="' + g.id + '">Delete</button></div>' +
        g.seats.map(function (s, i) { return '<div class="' + (i === g.winner ? 'w' : '') + '">' + (i === g.winner ? '🏆 ' : '') + esc(pName(s.p)) + ' <span class="muted">– ' + esc(dName(s.d)) + '</span></div>'; }).join('') + '</div>';
    }).join('');
    return { title: 'History', body: h || '<div class="empty">No games logged yet.</div>' };
  };

  function importInput() { return '<input type="file" id="imp" accept="application/json,.json" style="display:none">'; }

  V.more = function () {
    var s = S(), me = myId(), res = F(), cal = res.calibration || {};
    var players = Object.keys(db.players).map(function (k) { return db.players[k]; }).filter(function (p) { return !p.anon; });
    function num(key, label, help, step) {
      return '<label>' + label + '</label><input type="number" step="' + (step || 0.1) + '" data-s="' + key + '" value="' + s[key] + '"><p class="small muted" style="margin-top:4px">' + help + '</p>';
    }
    return { title: 'More', body:
      '<h2>You</h2><select data-me><option value="">Not set</option>' + players.map(function (p) { return '<option value="' + p.id + '"' + (p.id === me ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select>' +
      '<h2>Strength taps</h2>' +
      '<div class="seg"><button class="' + (s.askFeel ? 'on' : '') + '" data-act="askFeel" data-v="1">Ask after games</button><button class="' + (!s.askFeel ? 'on' : '') + '" data-act="askFeel" data-v="0">Never ask</button></div>' +
      num('feelThreshold', 'Only ask while uncertainty is above', 'Uncertainty in bracket steps. Higher means asking less often; once a deck is pinned down it stops being listed.') +
      '<h2>Estimates</h2><button class="btn sec" data-act="open" data-name="review">Review deck estimates</button>' +
      '<h2>Backup</h2><p class="small muted">Every game is saved on this device automatically as you go. A backup is just a safety copy, worth exporting now and then.</p>' +
      '<p class="small muted">iPhone: add the app to your Home Screen first and only use that icon. Safari and the Home Screen app keep separate data.</p>' +
      '<button class="btn" data-act="export">Export backup</button>' +
      '<button class="btn sec" data-act="copyBackup">Copy backup as text</button>' +
      '<button class="btn sec" data-act="pickImport">Import a backup file</button>' + importInput() +
      '<label>Or paste backup text</label><textarea data-f="paste" placeholder="Paste exported JSON here">' + esc(form.paste || '') + '</textarea>' +
      '<button class="btn sec" data-act="importPaste">Import pasted text</button>' +
      '<h2>Rating model (advanced)</h2>' +
      num('seedSd', 'Trust in your seed estimates', 'Typical error of a starting estimate, in bracket steps. Lower trusts your seeds more; higher lets results move ratings faster.') +
      num('skillSd', 'Spread of player skill', 'How different players can be, in bracket steps.') +
      num('shiftPerCard', 'Rating change per card changed', 'In bracket steps. 0.027 means 25 cards moves a deck about two thirds of a bracket (mid B3 to low B4).', 0.001) +
      num('volPerCard', 'Extra uncertainty per card changed', 'In bracket steps. After an update the rating becomes this much less certain, so new games can correct it faster.', 0.001) +
      '<label>Bracket spacing</label><div class="seg"><button class="' + (s.autoSpacing ? 'on' : '') + '" data-act="autoSpacing" data-v="1">Learn from my decks</button><button class="' + (!s.autoSpacing ? 'on' : '') + '" data-act="autoSpacing" data-v="0">Fixed</button></div>' +
      calibNote(cal) +
      num('kappa', s.autoSpacing ? 'Fallback spacing (used until there is enough data)' : 'Bracket spacing', 'How big a gap one bracket step makes to win chances. Compare the examples below with how often a stronger deck really wins at your table.', 0.1) +
      '<div class="note"><div class="small">Win chance in a four-player pod against three equal decks (at the spacing in use):</div><div id="kapnote">' + kappaNote(res.S.kappa) + '</div></div>' +
      '<button class="btn sec" data-act="resetModel">Reset model settings</button>' +
      '<h2>Danger zone</h2><button class="btn danger" data-act="eraseAll">Erase everything</button>' +
      '<p class="muted small">Deck Ledger · data stored on this device only.</p>' };
  };

  function calibNote(cal) {
    if (!cal || cal.off) return '';
    if (!cal.ok) {
      var have = (cal.rows || []).length;
      return '<div class="note">Not enough data yet: ' + have + ' of ' + (cal.need || 3) + ' decks have ' + (cal.minGames || 20) + '+ games' + (cal.flat ? ', and their seeds are all the same bracket, so there is no spread to calibrate on' : '') + '. Using the fallback spacing for now.</div>';
    }
    var rows = cal.rows.slice().sort(function (a, b) { return b.games - a.games; }).map(function (r) {
      return '<div class="row small" style="padding:3px 0"><span class="grow">' + esc(r.name) + ' <span class="muted">' + r.games + ' games</span></span><span class="muted">seeded ' + E.labelFor(r.seed + 3) + '</span></div>';
    }).join('');
    return '<div class="note">Spacing in use: <b>' + cal.kappa.toFixed(2) + '</b> per bracket. Your decks alone suggest ' + cal.raw.toFixed(2) + ' from ' + cal.evidence + ' games; this is blended with the fallback (' + cal.manual + ') and moves toward your data as games accumulate. Based on ' + cal.rows.length + ' well-played decks:' + rows + '<div class="small" style="margin-top:6px">This assumes your seeds are right on average across these decks. If they are all guessed too close together or too far apart, the scale inherits that.</div></div>';
  }

  function kappaNote(k) {
    var rows = [['A deck one tier up (low to mid)', 1 / 3], ['A deck one bracket up', 1], ['Mid B4 vs three low B2', 2.33], ['Mid B5 vs three low B2', 3.33]];
    return rows.map(function (r) { var e = Math.exp(k * r[1]); return '<div class="row small" style="padding:3px 0"><span class="grow">' + r[0] + '</span><b>' + Math.round(100 * e / (e + 3)) + '%</b></div>'; }).join('');
  }

  function notFound() { return { title: 'Not found', back: true, body: '<div class="empty">That item no longer exists.</div>' }; }

  // ---------------------------------------------------------------- sheets
  function sheetHtml() {
    if (!sheet) return '';
    var body = '', i = sheet.seat, seat = draft && draft.seats[i];
    if (sheet.type === 'player') {
      if (sheet.adding) {
        body = '<h3>New player</h3><input type="text" data-f="newName" data-autofocus value="' + esc(form.newName || '') + '" placeholder="Name" autocomplete="off">' + skillBlock() + '<button class="btn" data-act="newPlayerSave">Add and use</button>';
      } else {
        var used = {}; draft.seats.forEach(function (s, j) { if (j !== i && s.p) used[s.p] = 1; });
        var lu = lastUsed();
        var list = Object.keys(db.players).map(function (k) { return db.players[k]; }).filter(function (p) { return !p.anon && !p.retired && !used[p.id]; })
          .sort(function (a, b) { return (lu.p[b.id] || 0) - (lu.p[a.id] || 0) || a.name.localeCompare(b.name); });
        body = '<h3>Who is playing?</h3>' + list.map(function (p) { return '<button class="item" data-act="usePlayer" data-id="' + p.id + '"><span>' + esc(p.name) + (p.id === myId() ? ' <span class="pill accent">you</span>' : '') + '</span></button>'; }).join('') +
          '<button class="item" data-act="usePlayer" data-id="guest"><span>Guest <span class="muted small">(not tracked)</span></span></button>' +
          '<button class="item new" data-act="newPlayerOpen"><span>+ New player</span></button>';
      }
    } else if (sheet.type === 'deck') {
      var realP = seat && seat.p && seat.p !== 'guest';
      if (sheet.mode === 'unknown') {
        body = '<h3>Unknown deck</h3><p class="muted small">Just estimate how strong it is. It will not be rated, but it counts as an opponent.</p>' + seedChips() +
          '<p class="small muted">Estimate: <b>' + E.labelFor(seedFromForm()) + '</b></p><button class="btn" data-act="useUnknown">Use this</button>';
      } else if (sheet.mode === 'new') {
        body = '<h3>New deck for ' + esc(pName(seat.p)) + '</h3><input type="text" data-f="newName" data-autofocus value="' + esc(form.newName || '') + '" placeholder="Deck name" autocomplete="off">' +
          seedBlock(null) + '<button class="btn" data-act="newDeckSave">Add and use</button>';
      } else {
        var usedD = {}; draft.seats.forEach(function (s, j) { if (j !== i && s.d && typeof s.d === 'string') usedD[s.d] = 1; });
        var lu2 = lastUsed(), res = F();
        var all = Object.keys(db.decks).map(function (k) { return db.decks[k]; }).filter(function (d) { return !d.anon && !d.retired && !usedD[d.id]; });
        var mine = all.filter(function (d) { return realP && (d.ownerId === seat.p || lu2.pil[seat.p + '|' + d.id]); })
          .sort(function (a, b) { return (lu2.pil[seat.p + '|' + b.id] || 0) - (lu2.pil[seat.p + '|' + a.id] || 0) || a.name.localeCompare(b.name); });
        var others = all.filter(function (d) { return mine.indexOf(d) < 0; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        var item = function (d) { return '<button class="item" data-act="useDeck" data-id="' + d.id + '"><span>' + esc(d.name) + (d.ownerId && d.ownerId !== seat.p ? ' <span class="muted small">' + esc(pName(d.ownerId)) + '</span>' : '') + '</span><span class="muted small">' + E.labelFor(res.deck[d.id].mean) + '</span></button>'; };
        body = '<h3>Which deck?</h3>' + mine.map(item).join('') +
          '<button class="item new" data-act="deckUnknown"><span>Unknown deck (just estimate)</span></button>' +
          (realP ? '<button class="item new" data-act="deckNew"><span>+ New deck</span></button>' : '') +
          (others.length ? (sheet.showAll || !mine.length ? '<h2>' + (mine.length ? 'Other decks' : 'Existing decks') + '</h2>' + others.map(item).join('') : '<button class="item" data-act="showAllDecks"><span class="muted">Show other decks (borrowed)…</span></button>') : '');
      }
    }
    return '<div class="sheet-bg" data-act="closeSheet"><div class="sheet">' + body + '</div></div>';
  }

  // ---------------------------------------------------------------- render
  function render(toTop) {
    var main = document.querySelector('main'), st = main ? main.scrollTop : 0;
    var name = route.name;
    if (!Object.keys(db.players).length && name !== 'welcome') { name = 'welcome'; route = { name: 'welcome' }; }
    var v = V[name]();
    app.innerHTML = '<header class="top">' + (v.back ? '<button class="icon" data-act="back" aria-label="Back">‹</button>' : '') + '<h1>' + v.title + '</h1>' + (v.right || '') + '</header><main>' + v.body + '</main>' + (name === 'welcome' ? '' : tabbar()) + sheetHtml();
    var m = document.querySelector('main'); if (m && !toTop) m.scrollTop = st;
    var af = document.querySelector('[data-autofocus]'); if (af) setTimeout(function () { af.focus(); }, 30);
  }

  // ---------------------------------------------------------------- actions
  var A = {};
  A.tab = function (d) { tab(d.v); };
  A.back = function () { back(); };
  A.open = function (d) { var p = {}; if (d.id) p.id = d.id; if (d.kind) p.kind = d.kind; if (d.owner) p.owner = d.owner; nav(d.name, p); };
  A.deckFilter = function (d) { ui.deckFilter = d.v; render(); };
  A.sb = function (d) { form.sb = +d.v; render(); };
  A.st = function (d) { form.st = +d.v; render(); };
  A.setDir = function (d) { form.dir = d.v; render(); };
  A.closeSheet = function (d, el, e) { if (e.target === el) { sheet = null; render(); } };

  A.createMe = function () {
    var name = (form.name || '').trim(); if (!name) { toast('Enter your name'); return; }
    var id = uid(); db.players[id] = { id: id, name: name, created: Date.now() }; applySkill(db.players[id]); db.settings.me = id; save();
    route = { name: 'decks' }; render(true);
  };
  A.saveNewPlayer = function () {
    var name = (form.name || '').trim(); if (!name) { toast('Enter a name'); return; }
    var id = uid(); db.players[id] = { id: id, name: name, created: Date.now() }; applySkill(db.players[id]); if (!myId()) db.settings.me = id; save();
    stack.pop(); route = { name: 'player', id: id }; form = {}; render(true);
  };
  A.saveEditPlayer = function (d) {
    var name = (form.name || '').trim(); if (!name) { toast('Enter a name'); return; }
    db.players[d.id].name = name; applySkill(db.players[d.id]); save(); back();
  };
  A.makeMe = function (d) { db.settings.me = d.id; save(); toast('Set as you'); render(); };
  A.toggleRetire = function (d) {
    var ent = d.kind === 'deck' ? db.decks[d.id] : db.players[d.id]; ent.retired = !ent.retired; save(); back();
  };
  A.deletePlayer = function (d) { if (!confirm('Delete this player?')) return; delete db.players[d.id]; if (db.settings.me === d.id) delete db.settings.me; save(); stack = []; route = { name: 'players' }; render(true); };
  A.deleteDeck = function (d) { if (!confirm('Delete this deck?')) return; delete db.decks[d.id]; save(); stack = []; route = { name: 'decks' }; render(true); };

  A.saveNewDeck = function () {
    var name = (form.name || '').trim(); if (!name) { toast('Enter a deck name'); return; }
    if (!form.owner) { toast('Choose an owner'); return; }
    var sd = readSeed(null), id = uid(); db.decks[id] = { id: id, name: name, ownerId: form.owner, seed: 3, updates: [], created: Date.now() }; applySeed(db.decks[id], sd); save();
    stack.pop(); route = { name: 'deck', id: id }; form = {}; render(true);
  };
  A.saveEditDeck = function (d) {
    var name = (form.name || '').trim(); if (!name) { toast('Enter a deck name'); return; }
    var x = db.decks[d.id]; x.name = name; x.ownerId = form.owner || null; applySeed(x, readSeed(d.id)); save(); back();
  };
  A.reviewFilter = function (d) { ui.reviewFilter = d.v; form = {}; render(true); };
  A.reviewSave = function (d) { var x = db.decks[d.id]; if (!x) return; applySeed(x, readSeed()); delete x.needsSeed; save(); form = {}; render(true); };
  A.reviewSkip = function (d) { ui.reviewSkipped = ui.reviewSkipped || {}; ui.reviewSkipped[d.id] = 1; form = {}; render(true); };
  A.reviewLeave = function (d) { var x = db.decks[d.id]; if (x) { delete x.needsSeed; save(); } form = {}; render(true); };
  A.setConf = function (d) { form.conf = d.v; render(); };
  A.setSkill = function (d) { form.skill = d.v; render(); };
  A.setSkillConf = function (d) { form.skillConf = d.v; render(); };
  A.toggleGoal = function () { form.goalOn = !form.goalOn; render(); };
  A.saveUpdate = function (d) {
    var cards = parseInt(form.cards, 10); if (!(cards >= 1)) { toast('Enter how many cards changed'); return; }
    cards = Math.min(cards, 99);
    var est = F().deck[d.id].mean, goal = form.goalOn ? seedFromForm() : null;
    var dir = goal != null ? (goal > est ? 'up' : goal < est ? 'down' : 'same') : (form.dir || 'same');
    var u = { id: uid(), date: form.date || today(), seq: nextSeq(), cards: cards, dir: dir, shift: updateShift(cards, dir, goal, est, S()) };
    if (goal != null) u.goal = goal;
    db.decks[d.id].updates.push(u); save();
    toast('Update logged'); back();
  };
  A.savePromote = function (d) {
    var name = (form.name || '').trim(); if (!name) { toast('Enter a name'); return; }
    if (d.kind === 'player') { db.players[d.id].anon = false; db.players[d.id].name = name; applySkill(db.players[d.id]); }
    else { var x = db.decks[d.id]; x.anon = false; x.name = name; if (form.owner) x.ownerId = form.owner; }
    save(); toast('Saved. Earlier games now count.'); back();
  };

  // --- logging
  A.pickP = function (d) { sheet = { type: 'player', seat: +d.i }; render(); };
  A.pickD = function (d) { if (!draft.seats[+d.i].p) { toast('Choose the player first'); return; } sheet = { type: 'deck', seat: +d.i, mode: 'list' }; render(); };
  A.usePlayer = function (d) { draft.seats[sheet.seat].p = d.id; sheet = null; render(); };
  A.newPlayerOpen = function () { sheet.adding = true; form.newName = ''; form.skill = 'avg'; form.skillConf = 'fair'; render(); };
  A.newPlayerSave = function () {
    var name = (form.newName || '').trim(); if (!name) { toast('Enter a name'); return; }
    var id = uid(); db.players[id] = { id: id, name: name, created: Date.now() }; applySkill(db.players[id]); if (!myId()) db.settings.me = id; save();
    draft.seats[sheet.seat].p = id; sheet = null; form.newName = ''; render();
  };
  A.useDeck = function (d) { draft.seats[sheet.seat].d = d.id; sheet = null; render(); };
  A.showAllDecks = function () { sheet.showAll = true; render(); };
  A.deckUnknown = function () { sheet.mode = 'unknown'; form.sb = 3; form.st = 1; render(); };
  A.useUnknown = function () { draft.seats[sheet.seat].d = { anonSeed: seedFromForm() }; sheet = null; render(); };
  A.deckNew = function () { sheet.mode = 'new'; form.sb = 3; form.st = 1; form.newName = ''; form.conf = 'fair'; render(); };
  A.newDeckSave = function () {
    var name = (form.newName || '').trim(); if (!name) { toast('Enter a deck name'); return; }
    var p = draft.seats[sheet.seat].p, sd = readSeed(null), id = uid();
    db.decks[id] = { id: id, name: name, ownerId: p, seed: 3, updates: [], created: Date.now() }; applySeed(db.decks[id], sd); save();
    draft.seats[sheet.seat].d = id; sheet = null; form.newName = ''; render();
  };
  A.rmSeat = function (d) { draft.seats.splice(+d.i, 1); render(); };
  A.addSeat = function () { draft.seats.push({ p: null, d: null }); render(); };
  A.repeatPod = function () {
    var g = db.games.slice().sort(function (a, b) { return gkey(a) < gkey(b) ? 1 : -1; })[0]; if (!g) return;
    draft.seats = g.seats.map(function (s) {
      var pl = db.players[s.p], dk = db.decks[s.d];
      return { p: pl && !pl.anon ? s.p : 'guest', d: dk && !dk.anon ? s.d : { anonSeed: dk ? dk.seed : 3.5 } };
    });
    render();
  };
  A.toWinner = function () { draft.step = 2; draft.winner = null; render(true); };
  A.win = function (d) { draft.winner = +d.i; render(); };
  A.saveGame = function () {
    if (draft.winner == null) return;
    var seats = draft.seats.map(function (s) {
      var p = s.p, d = s.d;
      if (p === 'guest') { p = uid(); db.players[p] = { id: p, name: 'Guest', anon: true, created: Date.now() }; }
      if (typeof d === 'object') { var id = uid(); db.decks[id] = { id: id, name: 'Unknown deck', ownerId: p, anon: true, seed: d.anonSeed, updates: [], created: Date.now() }; d = id; }
      return { p: p, d: d };
    });
    var g = { id: uid(), date: draft.date || today(), seq: nextSeq(), seats: seats, winner: draft.winner, feels: [] };
    db.games.push(g); save();
    draft = null;
    var s = S(), res = F();
    var items = [];
    if (s.askFeel) seats.forEach(function (st) {
      var dk = db.decks[st.d], r = res.deck[st.d];
      if (dk && !dk.anon && !dk.retired && r && r.sd > s.feelThreshold && (st.p === myId() || r.games >= 5)) items.push(st.d);
    });
    feelSel = {};
    if (items.length) { stack = []; route = { name: 'feel', gid: g.id, items: items }; sheet = null; render(true); }
    else { toast('Game saved'); tab('decks'); }
  };
  A.feelSet = function (d) { feelSel[d.d] = +d.v; render(); };
  A.feelDone = function () {
    var g = db.games.find(function (x) { return x.id === route.gid; }), res = F();
    if (g) {
      g.feels = route.items.filter(function (id) { return feelSel[id]; }).map(function (id) { return { d: id, est: res.deck[id].mean, feel: feelSel[id] }; });
      save();
    }
    toast('Saved'); tab('decks');
  };
  A.delGame = function (d) { if (!confirm('Delete this game? Ratings will be recalculated.')) return; db.games = db.games.filter(function (g) { return g.id !== d.id; }); save(); render(); };

  // --- settings / backup
  A.askFeel = function (d) { db.settings.askFeel = d.v === '1'; save(); render(); };
  A.autoSpacing = function (d) { db.settings.autoSpacing = d.v === '1'; save(); render(); };
  A.resetModel = function () { ['seedSd', 'skillSd', 'kappa', 'shiftPerCard', 'volPerCard', 'autoSpacing'].forEach(function (k) { delete db.settings[k]; }); save(); render(); toast('Model settings reset'); };
  A.eraseAll = function () {
    if (!confirm('Erase ALL players, decks and games on this device?')) return;
    if (!confirm('Really erase everything? This cannot be undone.')) return;
    db = blank(); save(); stack = []; route = { name: 'welcome' }; render(true);
  };
  function backupText() { return JSON.stringify(db, null, 1); }
  A.export = function () {
    var text = backupText(), name = 'deck-ledger-' + today() + '.json';
    function fallback() {
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    }
    try {
      var file = new File([text], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Deck Ledger backup' }).catch(function (e) { if (!e || e.name !== 'AbortError') fallback(); }); return; }
    } catch (e) { /* use fallback */ }
    fallback();
  };
  A.copyBackup = function () {
    var text = backupText();
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Backup copied'); }, function () { toast('Copy failed'); });
    else toast('Copy not available here; use Export');
  };
  A.pickImport = function () { var el = document.getElementById('imp'); if (el) el.click(); };
  function importText(text) {
    var d; try { d = JSON.parse(text); } catch (e) { toast('That is not valid backup data'); return; }
    if (!d || typeof d.players !== 'object' || typeof d.decks !== 'object' || !Array.isArray(d.games)) { toast('That is not a Deck Ledger backup'); return; }
    var n = Object.keys(d.decks).length + ' decks, ' + d.games.length + ' games';
    if (Object.keys(db.players).length && !confirm('Replace everything on this device with the backup (' + n + ')?')) return;
    db = normalize(d); save(); stack = []; route = { name: 'decks' }; render(true); toast('Backup imported');
  }
  A.importPaste = function () { importText(form.paste || ''); };

  // ---------------------------------------------------------------- events
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var fn = A[el.dataset.act]; if (fn) fn(el.dataset, el, e);
  });
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.dataset.f) form[t.dataset.f] = t.value;
    if (t.dataset.s === 'kappa') { var kv = parseFloat(t.value), kn = document.getElementById('kapnote'); if (kn && isFinite(kv) && kv > 0) kn.innerHTML = kappaNote(kv); }
    if (t.dataset.dr && draft) draft[t.dataset.dr] = t.value;
    if (route.name === 'update' && t.dataset.f === 'cards') { var n = document.getElementById('upnote'); if (n && db.decks[route.id]) n.innerHTML = updateNote(db.decks[route.id]); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.s) {
      var v = parseFloat(t.value);
      if (isFinite(v) && v > 0) { db.settings[t.dataset.s] = v; save(); } else { delete db.settings[t.dataset.s]; save(); }
    }
    if (t.hasAttribute('data-me')) { if (t.value) db.settings.me = t.value; else delete db.settings.me; save(); toast('Saved'); }
    if (t.id === 'imp' && t.files && t.files[0]) {
      var r = new FileReader(); r.onload = function () { importText(String(r.result)); }; r.readAsText(t.files[0]); t.value = '';
    }
  });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () { });
  window.__DL = { get db() { return db; }, F: F };
  render(true);
})();
