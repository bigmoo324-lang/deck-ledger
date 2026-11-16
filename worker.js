/* Deck Ledger background worker: learns the table-size factors (see Engine.learnPodT) without freezing the app. */
importScripts('engine.js');
self.onmessage = function (e) {
  try { self.postMessage({ ok: true, r: self.Engine.learnPodT(e.data) }); }
  catch (err) { self.postMessage({ ok: false, err: String(err) }); }
};
