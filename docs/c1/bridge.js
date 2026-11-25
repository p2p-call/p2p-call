'use strict';

// When the way between two participants breaks: noticing it at once, mending
// it through the others, and letting a third one carry the voice meanwhile.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ a heartbeat

// The browser itself says a connection is lost only after several seconds of
// silence. The pages say "I'm here" to each other every second over their
// line, so a way that has gone dead shows within three. With it go the
// names of those this page hears well — whom it could pass a voice on from
// (see "a voice by way of a third").
const BEAT_EVERY = 1000, STALL_AFTER = 3000;
setInterval(() => {
  if (!state.me || state.ended) return;
  const ok = [...state.peers.values()].filter((p) => p.pc.connectionState === 'connected' && !p.stalled
    && !(p.q && p.q.level === 'bad')).map((p) => p.info.id);
  // all: everybody this page counts as being in the call, connected or not.
  const all = [...state.peers.keys()];
  for (const peer of state.peers.values()) toPeer(peer, { type: 'beat', ok, all });
  for (const peer of state.peers.values()) checkStall(peer);
  bridgeLook();
  carryCheck();
  // A page that missed the news of the call's new address (its line to the
  // organizer was down just then) hears it again.
  if (++beats % 30 === 0) tellMoved();
}, BEAT_EVERY);
let beats = 0;

// The organizer's page, when the link leads straight to the tunnel: where the call is now.
function tellMoved(only) {
  if (!state.direct || !state.me || !state.me.host || !state.invite) return;
  for (const peer of only ? [only] : state.peers.values()) toPeer(peer, { type: 'moved', url: state.invite });
}

// A way is dead when the other page has gone quiet on the line and its sound
// has stopped coming too: a page whose scripts the phone has put to sleep
// still sends its voice, and a voice that is switched off still sends its
// quiet packets, so either alone isn't proof.
async function checkStall(peer) {
  const late = Date.now() - peer.heardAt;
  if (!peer.beats || peer.pc.connectionState !== 'connected' || late < STALL_AFTER - 1000) {
    peer.packetsSeen = undefined;
    if (peer.stalled) { peer.stalled = false; render(); }
    return;
  }
  let got = 0;
  try {
    for (const r of peer.pc.getReceivers()) {
      if (!r.track || r.track.kind !== 'audio') continue;
      (await r.getStats()).forEach((s) => { if (s.type === 'inbound-rtp') got += s.packetsReceived || 0; });
    }
  } catch { return; }
  const was = peer.packetsSeen;
  peer.packetsSeen = got;
  if (was === undefined || got !== was || peer.stalled || late < STALL_AFTER) return;
  peer.stalled = true;
  send({ type: 'diag', text: `↔ ${peer.info.name}: connection went silent, repairing` });
  render();
  heal(peer, 0);
}

// Whether the way to them is out of order, by any sign.
function broken(peer) {
  return bad(peer.pc) || !!peer.stalled;
}

// ------------------------------------------------------------------ mending through the others

// A broken connection is mended with a fresh handshake, and a handshake has
// to get to the other side somehow: through the organizer's program, which
// may be out of reach just then (its tunnel dropped), or through the notice
// board, which is slow and counts every message. Whoever else is in the call
// and still connected to both is a third way, as quick as the line: the
// handshake is handed to them and they pass it on.
//
// Somebody passing a handshake on could change it and slip in between the
// two. So it goes signed, with a key each page makes for itself and tells
// the others over the line between them (which is itself sealed end to end,
// by the browsers): the one passing it on can carry it, or drop it, but not
// change it unseen.
const signing = crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  .then(async (pair) => ({ key: pair.privateKey, pub: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) }))
  .catch((e) => { console.warn('signing', e); return null; });

// Each handshake message is numbered, so the same one coming by two ways is
// taken once.
const signalsSeen = new Set();
let viaOut = Promise.resolve(), viaIn = Promise.resolve();   // strictly in order, both ways

// A handshake message for one peer, by every way that may get it there.
function signal(to, data) {
  data = { ...data, n: randomHex(6) };
  const peer = state.peers.get(to);
  const direct = peer && peer.pc.connectionState === 'connected' && !peer.stalled;
  const through = direct || !peer || !peer.pub ? [] : helpers(peer);
  // With no server, the board is the last resort: if somebody can pass it
  // on, the board is spared.
  if (!meet || direct || !through.length) send({ type: 'signal', to, data });
  if (!through.length) return;
  // t: when it was said — one kept by whoever passed it on and sent again
  // later is not taken.
  const d = JSON.stringify(data), t = Date.now();
  viaOut = viaOut.then(async () => {
    const s = await signing;
    if (!s) return;
    const sig = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, s.key, utf8.encode(`p2p-call-via|${state.me.id}|${to}|${t}|${d}`)));
    for (const h of through) toPeer(h, { type: 'via', from: state.me.id, to, t, d, sig });
  }).catch((e) => console.warn('via', e));
}

// Up to two others connected to us and, by their own word, to them.
function helpers(peer) {
  return [...state.peers.values()]
    .filter((h) => h !== peer && h.dc && h.dc.readyState === 'open' && !broken(h) && (h.sees || []).includes(peer.info.id))
    .slice(0, 2);
}

function signalOnce(data) {
  if (!data || typeof data.n !== 'string') return true;   // a page without numbers
  if (signalsSeen.has(data.n)) return false;
  signalsSeen.add(data.n);
  if (signalsSeen.size > 2000) signalsSeen.clear();
  return true;
}

// ------------------------------------------------------------------ a voice by way of a third

// If the way between A and B is broken or poor — or never came to be, as
// happens between two phones on some mobile networks — but both are well
// connected to C, then C passes A's voice on to B (and B's to A), mixed into
// its own: C's page hears A anyway. B then plays A from C and leaves the
// poor direct line quiet, until it is good again. Nothing to set up and no
// server of anybody's in between. Only the voice: pictures would be too
// heavy for C's connection.
//
// state.carry: what this page passes on — id of the one it goes to -> the
// ids of those whose voices are mixed in. peer.via: the one through whom
// this peer's voice comes to us now, if anyone.
state.carry = new Map();

// Every second: is there somebody we hear badly, and somebody who could help?
function bridgeLook() {
  const now = Date.now();
  for (const peer of state.peers.values()) {
    const poor = broken(peer) || (peer.q && peer.q.level === 'bad')
      // never connected after a good while
      || (peer.pc.connectionState !== 'connected' && !peer.everConnected && now - peer.born > 12000);
    peer.poorSince = poor ? peer.poorSince || now : 0;
    peer.goodSince = !poor && peer.q && peer.q.level === 'good' ? peer.goodSince || now : 0;
    const helper = peer.via && state.peers.get(peer.via);
    if (peer.via && (!helper || broken(helper) || !helper.dc || helper.dc.readyState !== 'open'
      || (now - peer.viaSince > 4000 && !(helper.sees || []).includes(peer.info.id)))) {
      // The one carrying it is gone, or no longer hears them well itself:
      // back to the direct line, or to another helper below.
      viaOff(peer, !!helper);
    }
    if (!peer.via && !peer.asked && peer.poorSince && now - peer.poorSince > 3000) {
      const h = [...state.peers.values()].find((x) => x !== peer && x.dc && x.dc.readyState === 'open'
        && !broken(x) && !(x.q && x.q.level === 'bad') && (x.sees || []).includes(peer.info.id));
      if (h) {
        peer.asked = h.info.id;
        peer.askedAt = now;
        toPeer(h, { type: 'carry', of: peer.info.id, on: true });
      }
    }
    if (peer.asked && !peer.via && now - peer.askedAt > 5000) peer.asked = '';   // no answer: ask again, maybe another
    if (peer.via && peer.goodSince && now - peer.goodSince > 9000) viaOff(peer, true);
  }
}

function viaOff(peer, tell) {
  const helper = state.peers.get(peer.via);
  if (tell && helper) toPeer(helper, { type: 'carry', of: peer.info.id, on: false });
  peer.via = '';
  peer.asked = '';
  peer.audio.muted = false;
  render();
}

// What the line says about all this. Says whether it was about it.
function bridgeWord(peer, m) {
  peer.heardAt = Date.now();
  switch (m.type) {
    case 'beat':
      peer.beats = true;
      peer.sees = (Array.isArray(m.ok) ? m.ok : []).filter((x) => typeof x === 'string').slice(0, 20);
      peer.knows = (Array.isArray(m.all) ? m.all : []).filter((x) => typeof x === 'string').slice(0, 20);
      return true;
    case 'key':
      // Told once, over the line the browsers have sealed between the two of
      // us; never changed afterwards. With no server, a page's name in the
      // call is its key's fingerprint, and the two must match.
      if (peer.pub || typeof m.pub !== 'string' || m.pub.length > 200) return true;
      (meet ? idOf(bytes(m.pub)).then((id) => id === peer.info.id) : Promise.resolve(true))
        .then((ok) => { if (ok && !peer.pub) peer.pub = m.pub; }).catch(() => {});
      return true;
    case 'via': {
      if (typeof m.d !== 'string' || m.d.length > 20000 || typeof m.to !== 'string' || typeof m.t !== 'number'
        || typeof m.sig !== 'string' || m.sig.length > 200) return true;
      if (m.to !== state.me.id) {
        // Passed on once, only for the one it came from, and nothing but what belongs to it.
        const to = state.peers.get(m.to);
        if (m.from === peer.info.id && to) toPeer(to, { type: 'via', from: m.from, to: m.to, t: m.t, d: m.d, sig: m.sig });
        return true;
      }
      const from = state.peers.get(m.from);
      if (!from || !from.pub || Math.abs(Date.now() - m.t) > 60000) return true;
      viaIn = viaIn.then(async () => {
        const pub = bytes(from.pub);
        if (!await signedBy(pub, bytes(m.sig), `p2p-call-via|${m.from}|${state.me.id}|${m.t}|${m.d}`)) return;
        if (state.peers.get(m.from) === from) onSignal(m.from, JSON.parse(m.d));
      }).catch((e) => console.warn('via', e));
      return true;
    }
    case 'carry': {
      // Pass a voice on to them, or stop.
      const of = state.peers.get(m.of);
      const set = state.carry.get(peer.info.id) || new Set();
      const can = m.on && of && of !== peer && mayCarry(of)
        // Only to somebody they count as being in the call themselves: one
        // who has shown up to this page alone gets nobody else's voice from it.
        && (of.knows || []).includes(peer.info.id);
      if (can) set.add(m.of);
      else set.delete(m.of);
      if (set.size) state.carry.set(peer.info.id, set);
      else state.carry.delete(peer.info.id);
      carryRefresh(peer);
      if (m.on) toPeer(peer, { type: 'carried', of: m.of, on: !!can });
      if (can) send({ type: 'diag', text: `↔ relaying voice ${of.info.name} → ${peer.info.name}: their direct link is poor` });
      return true;
    }
    case 'moved': {
      // From the organizer only, and to a page whose link went straight to
      // the tunnel. Whatever answers there must still prove itself the
      // organizer's program, by the key the call is named after (see agree).
      if (!peer.info.host || !far || !far.direct || typeof m.url !== 'string') return true;
      let to = '';
      try { to = new URL(m.url).origin; } catch { return true; }
      if (/^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/localhost:\d+)$/.test(to) && to !== state.server) {
        state.server = to;
        setInvite(directLink());   // the link in our own sheet, for whoever we call in
        send({ type: 'diag', text: `new call address: ${to}` });
      }
      return true;
    }
    case 'carried': {
      // A helper's answer: their voice now comes this way.
      const of = state.peers.get(m.of);
      if (!of || of.asked !== peer.info.id) return true;
      if (m.on) {
        of.via = peer.info.id;
        of.viaSince = Date.now();
        of.audio.muted = true;   // the poor direct line keeps quiet meanwhile
        send({ type: 'diag', text: `↔ ${of.info.name}: voice via ${peer.info.name}` });
      } else if (of.via === peer.info.id) {
        // They have stopped carrying it: the direct line speaks again.
        viaOff(of, false);
      }
      // (Refused: asked stays for a few seconds, so as not to ask again at once.)
      render();
      return true;
    }
  }
  return false;
}

// The line between two pages has opened.
function bridgeOpen(peer) {
  peer.heardAt = Date.now();
  signing.then((s) => { if (s) toPeer(peer, { type: 'key', pub: s.pub }); });
  tellMoved(peer);
}

// Whether their voice, as it comes to us, is fit to be passed on: it comes
// well, the mixer works — and it is theirs alone. If they are carrying
// somebody's voice to us, what comes from them is a mix, and passing that on
// could bring a voice back to its owner, or to somebody twice.
function mayCarry(of) {
  return !!of.inTrack && of.pc.connectionState === 'connected' && !of.stalled
    && !!state.audioCtx && state.audioCtx.state === 'running'
    && ![...state.peers.values()].some((p) => p.via === of.info.id);
}

// What goes out to one peer: our own sound, and the voices we carry for them.
function carryRefresh(peer) {
  if (!peer || !peer.audioSender) return;
  const ids = [...(state.carry.get(peer.info.id) || [])].filter((id) => {
    const of = state.peers.get(id);
    return of && of.inTrack;
  });
  if (peer.carryMix) {
    for (const n of peer.carryMix.nodes) n.disconnect();
    peer.carryMix = null;
  }
  if (!ids.length) {
    peer.audioSender.replaceTrack(outgoing()).catch((e) => console.warn('replaceTrack', e));
    return;
  }
  const ctx = state.audioCtx, out = ctx.createMediaStreamDestination(), nodes = [];
  for (const track of [outgoing(), ...ids.map((id) => state.peers.get(id).inTrack)]) {
    const n = ctx.createMediaStreamSource(new MediaStream([track]));
    n.connect(out);
    nodes.push(n);
  }
  peer.carryMix = { nodes, ids };
  peer.audioSender.replaceTrack(out.stream.getAudioTracks()[0]).catch((e) => console.warn('replaceTrack', e));
}

// Somebody has left, or their sound has changed: whatever was carried along is put together anew.
function carryForget(id) {
  state.carry.delete(id);
  for (const [to, set] of state.carry) {
    if (set.delete(id)) {
      if (!set.size) state.carry.delete(to);
      carryRefresh(state.peers.get(to));
      carryOver(to, id);
    }
  }
  for (const peer of state.peers.values()) {
    if (peer.via === id || peer.asked === id) viaOff(peer, false);
  }
}

// Voices we carry whose own way to us has broken are dropped: there is
// nothing good left to pass on. The one we carried them for will find another way.
function carryCheck() {
  for (const [to, set] of state.carry) {
    let changed = false;
    for (const id of [...set]) {
      const of = state.peers.get(id);
      if (!of || !mayCarry(of)) {
        set.delete(id);
        changed = true;
        carryOver(to, id);
      }
    }
    if (!changed) continue;
    if (!set.size) state.carry.delete(to);
    carryRefresh(state.peers.get(to));
  }
}

// Tells the one a voice was carried for that it no longer is, so that they
// don't go on waiting for it with the direct line kept quiet.
function carryOver(to, id) {
  const peer = state.peers.get(to);
  if (peer) toPeer(peer, { type: 'carried', of: id, on: false });
}

function carrying(peer) {
  return state.carry.has(peer.info.id);
}
