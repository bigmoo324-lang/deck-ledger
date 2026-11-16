/* Deck Ledger rating engine (pure JS, no DOM).
 *
 * Model: in each game, seat i has strength s_i = skill(player_i) + deck(deck_i, version at game time).
 * P(seat i wins) = softmax(s)_i  (works for any pod size, incl. 1v1).
 * Everything is fitted together (MAP estimate) from the full game history:
 *   - deck seeds (bracket estimates) are weak Gaussian priors
 *   - player skill has a Gaussian prior centred on 0
 *   - a deck update creates a new "version" of the deck: its prior is the previous version
 *     shifted by a small amount (cards changed, stronger/weaker) with extra volatility
 *   - optional "felt stronger/weaker" taps are weak observations of a deck's strength
 *   - optional per-game luck: who went first, and seats that took 2+ mulligans. Each is one shared
 *     parameter (logit units) with a prior centred on "no effect", learned from the games that record it
 *   - table size: in 4-player and 5+-player pods the strength gaps are multiplied by a factor t, because big
 *     tables stop the leader more often. t is learned out of sample (learnPodT: predict each big-pod game
 *     from all the others, then find the t that makes those predictions honest, with a prior on log t
 *     centred on 0 = "same as 3-player") and then held fixed while fitting. Fitting t jointly with the
 *     ratings does not work: it can always explain the games better by growing while the ratings shrink.
 * Uncertainty comes from the inverse Hessian (Laplace approximation).
 * Ratings are shown on a continuous bracket scale (1.0 - 5.99); internally in logit units.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    kappa: 1.5,        // logit units per bracket step (B4 mid vs three B2-low decks ~92%, cEDH ~98%)
    seedSd: 0.35,      // how wrong a "fairly sure" seed estimate typically is (brackets); rough x1.5, know-it-well x0.6
    skillSd: 0.4,      // spread of player skill (brackets)
    shiftPerCard: 0.01,// rating nudge per changed card when you say "stronger/weaker" (brackets)
    shiftCap: 0.5,     // max nudge from one such update (brackets)
    goalMaxFrac: 0.6,  // a stated target level moves the rating at most this fraction of the way
    goalFullCards: 40, // ...reached once this many cards changed (fewer cards = proportionally less)
    volBase: 0,        // no minimum extra uncertainty: 1 changed card is a tiny change
    volPerCard: 0.03,  // extra uncertainty per changed card (brackets)
    feelStep: 0.5,     // a "stronger/weaker" tap points this far from the estimate (brackets)
    feelSd: 1.5,       // how noisy a tap is (brackets); higher = gentler nudge
    askFeel: true,     // prompt for taps at all
    autoSpacing: true, // learn the bracket spacing from your seeds on well-played decks
    calibMinGames: 15, // a deck needs this many games to help calibrate
    calibMinDecks: 3,  // and this many such decks before calibration kicks in
    calibAnchor: 200,  // the fallback spacing counts as this many games' worth of evidence (shrinks early estimates toward it)
    useDeclared: false,  // use the owner's self-declared Playgroup bracket for unestimated decks (off: it made predictions worse on real data)
    placeholder: 'table', // 'table': unestimated decks assume the level of your deck in that game; 'fixed': B3 mid
    feelThreshold: 0.3, // only prompt for decks whose uncertainty (sd, brackets) is above this
    useFirst: true,    // allow for who went first (when recorded)
    useMull: true,     // allow for seats that took 2+ mulligans (when recorded)
    firstSd: 0.5,      // prior spread of the going-first effect (logit units, centred on 0)
    mullSd: 1.0,       // prior spread of the 2+ mulligan effect (logit units, centred on 0)
    usePod: true,      // learn how much strength gaps count in 4- and 5+-player pods (3-player is the reference)
    podSd: 0.5,        // prior spread of log(t) for those pods (0 = same as 3-player)
    podLearned: null   // learned table-size factors {4: t4, 5: t5, sd4, sd5, n4, n5, at}; see learnPodT
  };
  // which table-size class a pod belongs to: 4, 5 (5 and up), or null (2-3 players: reference)
  function podClass(n) { return n >= 5 ? 5 : n === 4 ? 4 : null; }
  function podT(podt, n) { var c = podClass(n); return c && podt && podt[c] ? podt[c] : 1; }
  function mullBad(st) { return (st && st.mull || 0) >= 2; }

  function settingsOf(db) {
    var s = {}, k, d = (db && db.settings) || {};
    for (k in DEFAULTS) s[k] = d[k] === undefined ? DEFAULTS[k] : d[k];
    return s;
  }

  function pad(n) { n = String(n); while (n.length < 8) n = '0' + n; return n; }
  function keyOf(date, seq) { return date + '|' + pad(seq); }

  // ---------- linear algebra (dense, small) ----------
  function cholesky(A, n) {
    var L = new Float64Array(n * n), i, j, k, sum;
    for (i = 0; i < n; i++) {
      for (j = 0; j <= i; j++) {
        sum = A[i * n + j];
        for (k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
        if (i === j) {
          if (sum <= 1e-12) sum = 1e-12;
          L[i * n + i] = Math.sqrt(sum);
        } else {
          L[i * n + j] = sum / L[j * n + j];
        }
      }
    }
    return L;
  }
  function cholSolve(L, b, n) {
    var y = new Float64Array(n), x = new Float64Array(n), i, k, s;
    for (i = 0; i < n; i++) {
      s = b[i];
      for (k = 0; k < i; k++) s -= L[i * n + k] * y[k];
      y[i] = s / L[i * n + i];
    }
    for (i = n - 1; i >= 0; i--) {
      s = y[i];
      for (k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
      x[i] = s / L[i * n + i];
    }
    return x;
  }

  // ---------- scale helpers ----------
  function bracketToLogit(b, S) { return S.kappa * (b - 3); }
  function logitToBracket(x, S) { return 3 + x / S.kappa; }
  var TIERS = ['low', 'mid', 'high'];
  function tierOf(b) {
    var f = b - Math.floor(b);
    return f < 1 / 3 ? 0 : f < 2 / 3 ? 1 : 2;
  }
  function labelFor(b) {
    var br = Math.min(5, Math.max(1, Math.floor(b)));
    var t = b < 1 ? 0 : b >= 6 ? 2 : tierOf(b);
    return 'B' + br + ' ' + TIERS[t];
  }
  function seedValue(bracket, tier) { return bracket + [1 / 6, 0.5, 5 / 6][tier]; }

  // ---------- model construction ----------
  function sortedUpdates(deck) {
    var u = (deck.updates || []).slice();
    u.sort(function (a, b) { var ka = keyOf(a.date, a.seq), kb = keyOf(b.date, b.seq); return ka < kb ? -1 : ka > kb ? 1 : 0; });
    return u;
  }
  function versionAt(ups, gkey) {
    var v = 0;
    for (var i = 0; i < ups.length; i++) if (keyOf(ups[i].date, ups[i].seq) < gkey) v = i + 1;
    return v;
  }

  var SKILL_TIERS = { weak: -0.5, avg: 0, strong: 0.5, very: 1.0 }; // bracket-equivalents relative to the typical player at your table
  var CONF = { rough: 1.5, fair: 1, solid: 0.6 }; // multipliers on seedSd, chosen per deck

  // A deck whose strength was never estimated (needsSeed / autoSeed) is assumed to match the table:
  // the average of your own deck's estimate in the games it appeared in. Falls back to B3 mid.
  function effectiveSeeds(db, S) {
    var out = {}, me = db.settings && db.settings.me, id;
    var isAuto = function (d) { return d && (d.needsSeed || d.autoSeed); };
    var real = function (d) { return d && !isAuto(d) && typeof d.seed === 'number'; };
    for (id in db.decks) out[id] = db.decks[id].seed;
    if (S.placeholder === 'fixed') { for (id in db.decks) if (isAuto(db.decks[id])) out[id] = 3.5; return out; }
    var acc = {};
    (db.games || []).forEach(function (g) {
      if (!me) return;
      var mine = null;
      g.seats.forEach(function (st) { if (st.p === me && real(db.decks[st.d])) mine = db.decks[st.d].seed; });
      if (mine == null) return;
      g.seats.forEach(function (st) { if (st.p !== me && isAuto(db.decks[st.d])) { acc[st.d] = acc[st.d] || { s: 0, n: 0 }; acc[st.d].s += mine; acc[st.d].n++; } });
    });
    // owner-based defaults: an explicit "their decks are usually around X" on the player, else the average of
    // the owner's estimated decks (2 or more), else the table level, else B3 mid
    var ownerAvg = {};
    for (id in db.decks) { var d2 = db.decks[id], o = d2.ownerId; if (!o || !real(d2) || d2.anon) continue; ownerAvg[o] = ownerAvg[o] || { s: 0, n: 0 }; ownerAvg[o].s += d2.seed; ownerAvg[o].n++; }
    out.__why = {};
    for (id in db.decks) if (isAuto(db.decks[id])) {
      var dk = db.decks[id], ow = dk.ownerId && db.players[dk.ownerId];
      if (ow && typeof ow.deckLevel === 'number') { out[id] = ow.deckLevel; out.__why[id] = 'owner'; }
      else if (S.useDeclared !== false && typeof dk.declared === 'number') { out[id] = dk.declared + 0.5; out.__why[id] = 'declared'; }
      else if (ow && ownerAvg[dk.ownerId] && ownerAvg[dk.ownerId].n >= 3) { out[id] = ownerAvg[dk.ownerId].s / ownerAvg[dk.ownerId].n; out.__why[id] = 'ownerAvg'; }
      else if (acc[id]) { out[id] = acc[id].s / acc[id].n; out.__why[id] = 'table'; }
      else { out[id] = 3.5; out.__why[id] = 'default'; }
    }
    return out;
  }

  function build(db) {
    var S = settingsOf(db), kappa = S.kappa, seeds = effectiveSeeds(db, S);
    var params = 0, pIdx = {}, dInfo = {}, quads = [], init = [];
    var id;

    for (id in db.players) {
      var pl = db.players[id];
      if (pl.anon) continue;
      pIdx[id] = params++;
      init.push(0);
      var sk = (SKILL_TIERS[pl.skill] || 0) * kappa, ssd = S.skillSd * (CONF[pl.skillConf] || 1) * kappa;
      init[init.length - 1] = sk;
      quads.push({ idx: [pIdx[id]], coef: [1], c: sk, w: 1 / (ssd * ssd) });
    }
    // pass 1: allocate a parameter per deck version
    for (id in db.decks) {
      var dk0 = db.decks[id];
      if (dk0.anon) continue;
      var ups0 = sortedUpdates(dk0), idxs0 = [];
      for (var v0 = 0; v0 <= ups0.length; v0++) { idxs0.push(params++); init.push(0); }
      dInfo[id] = { idxs: idxs0, ups: ups0 };
    }
    // pass 2: priors. A deck's starting prior is your bracket guess, weighted by how sure you said you were.
    for (id in dInfo) {
      var dk = db.decks[id], ups = dInfo[id].ups, idxs = dInfo[id].idxs;
      var sd = S.seedSd * (CONF[dk.conf] || 1);
      var prevMean = bracketToLogit(seeds[id], S);
      quads.push({ idx: [idxs[0]], coef: [1], c: prevMean, w: 1 / Math.pow(sd * kappa, 2) });
      init[idxs[0]] = prevMean;
      for (var v = 1; v <= ups.length; v++) {
        var u = ups[v - 1];
        var dir = u.dir === 'up' ? 1 : u.dir === 'down' ? -1 : 0;
        var shiftBr = typeof u.shift === 'number' ? u.shift : dir * Math.min(u.cards * S.shiftPerCard, S.shiftCap);
        var shift = shiftBr * kappa;
        var tau = (S.volBase + S.volPerCard * u.cards) * kappa;
        prevMean += shift;
        init[idxs[v]] = prevMean;
        quads.push({ idx: [idxs[v], idxs[v - 1]], coef: [1, -1], c: shift, w: 1 / (tau * tau) });
      }
    }

    // shared luck parameters, only if some game records them
    var fx = {}, anyFirst = false, anyMull = false;
    (db.games || []).forEach(function (g) { (g.seats || []).forEach(function (st) { if (st.first) anyFirst = true; if (mullBad(st)) anyMull = true; }); });
    if (S.useFirst && anyFirst) { fx.first = params++; init.push(0); quads.push({ idx: [fx.first], coef: [1], c: 0, w: 1 / (S.firstSd * S.firstSd) }); }
    if (S.useMull && anyMull) { fx.mull2 = params++; init.push(0); quads.push({ idx: [fx.mull2], coef: [1], c: 0, w: 1 / (S.mullSd * S.mullSd) }); }

    var games = [];
    (db.games || []).forEach(function (g) {
      if (!g.seats || g.seats.length < 2 || g.winner == null || !g.seats[g.winner]) return;
      var gkey = keyOf(g.date, g.seq);
      var seats = g.seats.map(function (st) {
        var params_ = [], c = 0, pl2 = db.players[st.p], dk2 = db.decks[st.d];
        if (pl2 && !pl2.anon) params_.push(pIdx[st.p]);
        var ver = 0;
        if (dk2 && dk2.anon) c += bracketToLogit(seeds[st.d], S);
        else if (dk2) { ver = versionAt(dInfo[st.d].ups, gkey); params_.push(dInfo[st.d].idxs[ver]); }
        if (st.first && fx.first != null) params_.push(fx.first);
        if (mullBad(st) && fx.mull2 != null) params_.push(fx.mull2);
        return { params: params_, c: c, d: st.d, p: st.p, ver: ver };
      });
      games.push({ seats: seats, winner: g.winner, id: g.id, t: S.usePod ? podT(S.podLearned, seats.length) : 1, n: seats.length });
      (g.feels || []).forEach(function (fl) {
        if (!fl.feel || !dInfo[fl.d]) return;
        var seat = null;
        seats.forEach(function (s) { if (s.d === fl.d) seat = s; });
        if (!seat) return;
        var target = bracketToLogit(fl.est + fl.feel * S.feelStep, S);
        quads.push({ idx: [dInfo[fl.d].idxs[seat.ver]], coef: [1], c: target, w: 1 / Math.pow(S.feelSd * kappa, 2) });
      });
    });

    return { S: S, n: params, pIdx: pIdx, dInfo: dInfo, quads: quads, games: games, init: init, seeds: seeds, fx: fx };
  }

  function evaluate(th, m, wantH) {
    var n = m.n, f = 0, g = new Float64Array(n), H = wantH ? new Float64Array(n * n) : null;
    var q, a, b, r, i, j, gi, k;
    for (k = 0; k < m.quads.length; k++) {
      q = m.quads[k];
      r = -q.c;
      for (a = 0; a < q.idx.length; a++) r += q.coef[a] * th[q.idx[a]];
      f += 0.5 * q.w * r * r;
      for (a = 0; a < q.idx.length; a++) {
        g[q.idx[a]] += q.w * r * q.coef[a];
        if (H) for (b = 0; b < q.idx.length; b++) H[q.idx[a] * n + q.idx[b]] += q.w * q.coef[a] * q.coef[b];
      }
    }
    for (gi = 0; gi < m.games.length; gi++) {
      var game = m.games[gi], seats = game.seats, np = seats.length, tt = game.t || 1;
      var s = new Array(np), mx = -Infinity, Z = 0, p = new Array(np);
      for (i = 0; i < np; i++) {
        s[i] = seats[i].c;
        for (a = 0; a < seats[i].params.length; a++) s[i] += th[seats[i].params[a]];
        s[i] *= tt;
        if (s[i] > mx) mx = s[i];
      }
      for (i = 0; i < np; i++) { p[i] = Math.exp(s[i] - mx); Z += p[i]; }
      for (i = 0; i < np; i++) p[i] /= Z;
      f -= Math.log(p[game.winner]);
      for (i = 0; i < np; i++) {
        var gs = tt * (p[i] - (i === game.winner ? 1 : 0));
        for (a = 0; a < seats[i].params.length; a++) g[seats[i].params[a]] += gs;
        if (H) {
          for (j = 0; j < np; j++) {
            var h = tt * tt * ((i === j ? p[i] : 0) - p[i] * p[j]);
            if (h === 0) continue;
            for (a = 0; a < seats[i].params.length; a++)
              for (b = 0; b < seats[j].params.length; b++)
                H[seats[i].params[a] * n + seats[j].params[b]] += h;
          }
        }
      }
    }
    return { f: f, g: g, H: H };
  }

  function fitOnce(db, warm, opts) {
    opts = opts || {};
    var m = build(db), S = m.S, n = m.n, kappa = S.kappa;
    var res = { S: S, deck: {}, player: {}, theta: null, model: m };
    var th = (warm && warm.length === n) ? Float64Array.from(warm) : Float64Array.from(m.init);
    var cov = null, iter, ev, i;

    if (n > 0) {
      ev = evaluate(th, m, true);
      for (iter = 0; iter < 60; iter++) {
        var L = cholesky(ev.H, n);
        var negg = new Float64Array(n);
        for (i = 0; i < n; i++) negg[i] = -ev.g[i];
        var dlt = cholSolve(L, negg, n);
        var slope = 0, maxStep = 0;
        for (i = 0; i < n; i++) slope += ev.g[i] * dlt[i];
        var step = 1, th2 = null, ev2 = null;
        while (step > 1e-6) {
          th2 = new Float64Array(n);
          for (i = 0; i < n; i++) th2[i] = th[i] + step * dlt[i];
          ev2 = evaluate(th2, m, false);
          if (ev2.f <= ev.f + 1e-4 * step * slope) break;
          step /= 2;
        }
        for (i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.abs(step * dlt[i]));
        th = th2;
        ev = evaluate(th, m, true);
        if (maxStep < 1e-7) break;
      }
      var Lf = cholesky(ev.H, n);
      if (opts.noCov) { cov = new Float64Array(n); for (i = 0; i < n; i++) cov[i] = 1 / Math.max(1e-9, ev.H[i * n + i]); }
      var logdet = 0;
      for (i = 0; i < n; i++) logdet += 2 * Math.log(Lf[i * n + i]);
      var norm = 0;
      m.quads.forEach(function (q) { norm += 0.5 * Math.log(q.w / (2 * Math.PI)); });
      res.logEvidence = -ev.f + 0.5 * n * Math.log(2 * Math.PI) - 0.5 * logdet + norm;
      if (!opts.noCov) {
      cov = new Float64Array(n);
      var e = new Float64Array(n);
      for (i = 0; i < n; i++) {
        e.fill(0); e[i] = 1;
        cov[i] = cholSolve(Lf, e, n)[i];
      }
      }
    }
    res.theta = th; res.seeds = m.seeds; res.podT = S.usePod ? (S.podLearned || null) : null;
    res.fx = {};
    Object.keys(m.fx).forEach(function (k) { var ix = m.fx[k]; res.fx[k] = { v: th[ix], sd: Math.sqrt(cov[ix]) }; });

    var id;
    for (id in m.pIdx) {
      var ix = m.pIdx[id];
      res.player[id] = { skill: th[ix] / kappa, sd: Math.sqrt(cov[ix]) / kappa, games: 0, wins: 0 };
    }
    for (id in m.dInfo) {
      var info = m.dInfo[id], vers = info.idxs.map(function (ix2, v) {
        return { mean: logitToBracket(th[ix2], S), sd: Math.sqrt(cov[ix2]) / kappa, key: v ? keyOf(info.ups[v - 1].date, info.ups[v - 1].seq) : '' };
      });
      var cur = vers[vers.length - 1];
      res.deck[id] = { mean: cur.mean, sd: cur.sd, versions: vers, games: 0, wins: 0 };
    }
    m.games.forEach(function (g) {
      g.seats.forEach(function (st, i) {
        var w = i === g.winner ? 1 : 0;
        if (res.deck[st.d]) { res.deck[st.d].games++; res.deck[st.d].wins += w; }
        if (res.player[st.p]) { res.player[st.p].games++; res.player[st.p].wins += w; }
      });
    });
    // games/wins for anonymous entities too (so the Guests screen can show them)
    m.games.forEach(function (g) {
      g.seats.forEach(function (st, i) {
        if (!res.deck[st.d] && db.decks[st.d]) {
          res.deck[st.d] = res.deck[st.d] || { mean: m.seeds[st.d], sd: S.seedSd, versions: [], games: 0, wins: 0, anon: true };
          res.deck[st.d].games++; if (i === g.winner) res.deck[st.d].wins++;
        }
        if (!res.player[st.p] && db.players[st.p]) {
          res.player[st.p] = res.player[st.p] || { skill: 0, sd: S.skillSd, games: 0, wins: 0, anon: true };
          res.player[st.p].games++; if (i === g.winner) res.player[st.p].wins++;
        }
      });
    });
    return res;
  }

  // logit bonus/penalty for a seat's recorded luck (went first, 2+ mulligans)
  function luck(res, st) {
    var fx = (res && res.fx) || {}, x = 0;
    if (st && st.first && fx.first) x += fx.first.v;
    if (mullBad(st) && fx.mull2) x += fx.mull2.v;
    return x;
  }
  // Predicted win chances for a list of seats [{p,d,first?,mull?}], using point estimates.
  function predict(res, db, seats, seeds) {
    seeds = seeds || res.seeds || {};
    var S = res.S, s = seats.map(function (st) {
      var pl = res.player[st.p], dk = res.deck[st.d], dd = db.decks[st.d];
      var skill = pl && !pl.anon ? pl.skill : 0;
      var deck = dk && !dk.anon ? dk.mean : dd ? (seeds[st.d] != null ? seeds[st.d] : dd.seed) : (st.seed || 3);
      return (skill + deck - 3) * S.kappa + luck(res, st);
    });
    var tt = podT(res.podT, seats.length); s = s.map(function (x) { return x * tt; });
    var mx = Math.max.apply(null, s), Z = 0;
    var p = s.map(function (x) { var e = Math.exp(x - mx); Z += e; return e; });
    return p.map(function (x) { return x / Z; });
  }

  // Calibrate the bracket spacing from the seeds of well-played decks: pick the spacing that makes
  // "strength units learned from results" line up with "brackets you seeded", weighted by games and confidence.
  // Results fix the gaps between decks; this only decides how many of those units make one bracket.
  function calibrate(db, res, fallback) {
    var S = res.S, rows = [];
    for (var id in res.deck) {
      var r = res.deck[id], dk = db.decks[id];
      if (r.anon || r.games < S.calibMinGames || !dk || dk.needsSeed || dk.autoSeed) continue;
      var w = r.games / (CONF[dk.conf] || 1);
      rows.push({ id: id, name: dk.name, units: (r.mean - 3) * S.kappa, usd: r.sd * S.kappa, seed: dk.seed - 3, ssd: S.seedSd * (CONF[dk.conf] || 1), w: w, games: r.games, conf: dk.conf || 'fair' });
    }
    if (rows.length < S.calibMinDecks) return { ok: false, rows: rows, need: S.calibMinDecks, minGames: S.calibMinGames };
    var sw = 0, su = 0, ss = 0; rows.forEach(function (x) { sw += x.w; su += x.w * x.units; ss += x.w * x.seed; });
    // Both sides are noisy (seeds by ~seedSd*conf, learned strengths by their posterior sd), so a plain
    // regression slope would come out too small. Compare the noise-corrected spreads instead.
    var mu = su / sw, ms = ss / sw, vu = 0, vs = 0, cov = 0, nu = 0, ns = 0;
    rows.forEach(function (x) {
      vu += x.w * (x.units - mu) * (x.units - mu); vs += x.w * (x.seed - ms) * (x.seed - ms); cov += x.w * (x.units - mu) * (x.seed - ms);
      nu += x.w * x.usd * x.usd; ns += x.w * x.ssd * x.ssd;
    });
    vu /= sw; vs /= sw; cov /= sw; nu /= sw; ns /= sw;
    var vsT = vs - ns, vuT = vu - nu;
    if (vs < 1e-9 || cov <= 0) return { ok: false, rows: rows, need: S.calibMinDecks, minGames: S.calibMinGames, flat: true };
    if (vsT < 0.25 * vs) vsT = 0.25 * vs; // seeds barely spread beyond their own noise: do not over-correct
    if (vuT < 0.25 * vu) vuT = 0.25 * vu;
    var kRaw = Math.sqrt(vuT / vsT); // units per bracket
    var evid = 0; rows.forEach(function (x) { evid += x.games; });
    var k = Math.exp((evid * Math.log(kRaw) + S.calibAnchor * Math.log(fallback)) / (evid + S.calibAnchor));
    k = Math.min(4, Math.max(0.5, k));
    return { ok: true, kappa: k, raw: kRaw, evidence: evid, rows: rows, spread: Math.sqrt(vs) };
  }

  // Learn the table-size factors out of sample: predict every 4- and 5+-player game from all the other games
  // (ratings fitted without any table-size factor), then find for each class the t that makes those
  // predictions most honest: MAP of log t under a N(0, podSd) prior. Slow-ish (one quick refit per big game),
  // so the app runs it in the background and stores the result in settings.podLearned.
  function learnPodT(db) {
    var off = { settings: Object.assign({}, db.settings, { usePod: false }), players: db.players, decks: db.decks, games: db.games };
    var S = settingsOf(off), base = fit(off), sets = { 4: [], 5: [] };
    (db.games || []).forEach(function (g) {
      var c = podClass(g.seats ? g.seats.length : 0); if (!c || g.winner == null) return;
      var r = fit({ settings: off.settings, players: db.players, decks: db.decks, games: db.games.filter(function (x) { return x.id !== g.id; }) }, base, { quick: true });
      sets[c].push({ p: predict(r, off, g.seats, base.seeds), w: g.winner });
    });
    var out = { at: Date.now() };
    [4, 5].forEach(function (c) {
      var G = sets[c], sd2 = S.podSd * S.podSd, tau = 0, d2 = 1 / sd2;
      for (var it = 0; it < 60 && G.length; it++) {
        var b = Math.exp(tau), g1 = 0, h = 0;
        G.forEach(function (gm) {
          var lp = gm.p.map(function (x) { return Math.log(Math.max(x, 1e-12)); }), q = lp.map(function (l) { return Math.exp(b * l); });
          var Z = q.reduce(function (x, y) { return x + y; }, 0), mean = 0, v = 0;
          q.forEach(function (x, i) { mean += x / Z * lp[i]; }); q.forEach(function (x, i) { v += x / Z * Math.pow(lp[i] - mean, 2); });
          g1 += mean - lp[gm.w]; h += v;
        });
        var d1 = b * g1 + tau / sd2; d2 = b * b * h + b * g1 + 1 / sd2; if (!(d2 > 1e-9)) d2 = b * b * h + 1 / sd2;
        var st = Math.max(-0.5, Math.min(0.5, d1 / d2)); tau -= st; if (Math.abs(st) < 1e-8) break;
      }
      out[c] = Math.exp(tau); out['sd' + c] = Math.sqrt(1 / d2); out['n' + c] = G.length;
    });
    return out;
  }

  function fit(db, warm, opts) {
    var S0 = settingsOf(db);
    var wth = warm && warm.theta, wk = warm && warm.S && warm.S.kappa;
    if (opts && opts.quick && warm) {
      // refit for a prediction: keep the already-calibrated spacing, skip the covariance
      var q = { settings: Object.assign({}, db.settings, { kappa: wk || S0.kappa }), players: db.players, decks: db.decks, games: db.games };
      var rq = fitOnce(q, wth, { noCov: true }); rq.calibration = warm.calibration; return rq;
    }
    if (!S0.autoSpacing) { var r0 = fitOnce(db, wth); r0.calibration = { ok: false, off: true }; return r0; }
    var work = { settings: Object.assign({}, db.settings), players: db.players, decks: db.decks, games: db.games };
    if (wk) work.settings.kappa = wk; // start from the previously calibrated spacing
    var res = fitOnce(work, wth), cal = calibrate(work, res, S0.kappa), last = null;
    for (var it = 0; it < 4 && cal.ok; it++) {
      if (last !== null && Math.abs(cal.kappa - last) < 0.01) break;
      last = cal.kappa;
      work.settings.kappa = cal.kappa;
      res = fitOnce(work, res.theta);
      cal = calibrate(work, res, S0.kappa);
    }
    res.calibration = cal;
    res.calibration.manual = S0.kappa;
    return res;
  }

  return {
    DEFAULTS: DEFAULTS, settingsOf: settingsOf, fit: fit, predict: predict,
    labelFor: labelFor, tierOf: tierOf, seedValue: seedValue, keyOf: keyOf,
    SKILL_TIERS: SKILL_TIERS, bracketToLogit: bracketToLogit, logitToBracket: logitToBracket, sortedUpdates: sortedUpdates, luck: luck, podT: podT, podClass: podClass, learnPodT: learnPodT
  };
});
