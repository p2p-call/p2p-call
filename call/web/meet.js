'use strict';

// A call with no server: the pages find each other on the notice boards.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ a call with no server

// A call created on the site's page has no program behind it: nobody to
// introduce the participants. They find each other on a public notice board
// (ntfy.sh) instead. Whoever comes in says so there; those already in the
// call answer, the handshakes are exchanged there too — and from then on
// the pages talk to each other directly, over a line of their own beside
// the sound and the picture. The board is used again only to let the next
// one in, or to mend a connection that broke.
//
// Everything put on the board is sealed with a key from the link's secret —
// the part of the link that is never sent to any server — and the board's
// own name for the call is derived from that secret too. The board sees
// that somebody talks, from where and how much; not who, nor what.
//
// There is no server to enforce the organizer's word either. The organizer
// is whoever holds the key the call is named after (it stays in the browser
// that created the call); their orders — remove, lock, mute, end — go out
// signed, and every page checks the signature and obeys.

// The board allows 250 messages a day from one address, all its users at
// that address together — and the organizer's program, with its permanent
// link, draws on the same allowance. A call needs a few per person; a page
// that finds itself sending many more than that has gone wrong, and stops
// before it takes the day's allowance with it.
const BOARD_MOST = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unurl = (s) => bytes(s.replace(/-/g, '+').replace(/_/g, '/'));
const randomHex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

// Whoever has the link can write on the board — but not in somebody else's
// name. Each page makes a key of its own for the call; its name there (id)
// is the key's fingerprint, and every message it puts on the board is signed
// with it. So a message "from" a participant is theirs or it is thrown away,
// and nobody can slip in between two participants by answering for them.
const idOf = async (pub) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pub)).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');

const mt = {
  myKey: null, myPub: '',          // this page's own key for the call
  orders: new Set(),               // the organizer's orders already carried out
  rosters: new Map(), odd: new Map(),   // who the others say they see; see compareRosters
  key: null, topic: '',            // the seal and the board's name for the call
  spare: [], spent: false,         // the lines to the spare boards; the first board has had enough of us for today
  sub: null, since: 0, began: 0, wait: 3000, seen: new Set(), parts: new Map(),
  out: Promise.resolve(), in: Promise.resolve(),   // one at a time, in order
  said: 0,                         // messages put on the board by this page
  hostKey: null, hostPub: '', proof: null,         // set in the organizer's browser
  status: { muted: false, music: false, video: '' },
  banned: new Set(), lockT: 0, lockOrder: null,
  closed: false,
};

async function meetKeys() {
  const base = await crypto.subtle.importKey('raw', unurl(far.secret), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const from = (purpose) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(`p2p-call board ${purpose}|${far.room}`) });
  mt.key = await crypto.subtle.deriveKey(from('key'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  mt.topic = 'p2pcall_' + b64url(await crypto.subtle.deriveBits(from('topic'), base, 128));
  // The organizer's key, if this is the browser the call was created in.
  let mine = null;
  try { mine = JSON.parse(local.get('p2p.host.' + far.room) || session.get('p2p.host.' + far.room) || 'null'); } catch { /* none */ }
  if (mine) {
    mt.hostKey = await crypto.subtle.importKey('jwk', mine.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    mt.hostPub = mine.pub;
  }
}

const hostSign = async (text) => b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, mt.hostKey, utf8.encode(text)));

// Packs or unpacks. Unpacking stops at a size no honest message reaches: a
// few bytes can be made to unpack into gigabytes.
async function squeeze(data, Stream) {
  const s = new Stream('deflate-raw');
  const w = s.writable.getWriter();
  w.write(data).catch(() => {});
  w.close().catch(() => {});
  const reader = s.readable.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 256 * 1024) {
      reader.cancel().catch(() => {});
      throw new Error('too big');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// One message for the board: packed, sealed, and cut in pieces if it is
// longer than the board takes (a handshake usually fits in one).
function boardSay(m, keep) {
  m.f = state.me.id;
  const body = JSON.stringify(m);
  if (++mt.said > BOARD_MOST) {
    if (mt.said === BOARD_MOST + 1) toast('This page has posted too much to the message board and stopped, so it won’t let new people in. Rejoin the call.', 8000);
    return;
  }
  mt.out = mt.out.then(async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sig = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, mt.myKey, utf8.encode(`p2p-call-board|${far.room}|${body}`)));
    const packed = await squeeze(utf8.encode(JSON.stringify({ b: body, p: mt.myPub, s: sig })), CompressionStream);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, mt.key, packed));
    const all = new Uint8Array(12 + sealed.length);
    all.set(iv);
    all.set(sealed, 12);
    const text = b64(all), size = 3600, n = Math.ceil(text.length / size), mid = randomHex(4);
    for (let i = 0; i < n; i++) await boardPut(`${mid}.${i}.${n}.${text.slice(i * size, (i + 1) * size)}`, keep && n === 1);
  }).catch((e) => console.warn('board', e));
}

// Every board gets it. If a spare one took it, the first board refusing is
// no trouble, and nothing is said about it. keep: the spare boards are to
// remember this one for whoever comes later (they remember one message).
async function boardPut(body, keep) {
  const spared = mt.spare.map((line) => line.say(body, keep)).some(Boolean);
  const trouble = (text, ms) => { if (!spared) toast(text, ms); };
  if (mt.spent) return trouble('Your network has hit today’s message board limit: some people may not be able to join.', 6000);
  for (let tries = 0; ; tries++) {
    try {
      const r = await fetch(`${CONF.board}/${mt.topic}`, { method: 'POST', body });
      if (r.ok) return;
      if (r.status !== 429) throw new Error('board ' + r.status);
      let why = {};
      try { why = await r.json(); } catch { /* the number says enough */ }
      if (why.code === 42908) {
        // The day's allowance for this address is spent; waiting won't help.
        mt.spent = true;
        return trouble('Your network has hit today’s message board limit. Try another network, such as mobile data.', 10000);
      }
      if (tries === 0) trouble('The message board asks us to wait — this takes a few seconds.', 6000);
    } catch (e) {
      console.warn('board', e);
    }
    if (spared) return;
    if (tries >= 3) return toast('Can’t post to the message board: some people may not be able to join.', 6000);
    await sleep(tries ? 10000 : 3000);
  }
}

async function boardRead(body) {
  const m = /^([0-9a-f]{8})\.(\d+)\.(\d+)\.([A-Za-z0-9+/=]+)$/.exec(body);
  if (!m) return null;
  // The same message comes from every board that carried it.
  const piece = m[1] + '.' + m[2];
  if (mt.seen.has(piece)) return null;
  mt.seen.add(piece);
  let text = m[4];
  const n = Number(m[3]);
  if (n > 1) {
    if (n > 8) return null;
    const got = mt.parts.get(m[1]) || [];
    got[Number(m[2])] = text;
    if (mt.parts.size > 30) mt.parts.clear();   // pieces nobody finished
    mt.parts.set(m[1], got);
    for (let i = 0; i < n; i++) if (got[i] === undefined) return null;
    mt.parts.delete(m[1]);
    text = got.join('');
  }
  const all = bytes(text);
  const packed = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, mt.key, all.slice(12));
  const signed = JSON.parse(new TextDecoder().decode(await squeeze(new Uint8Array(packed), DecompressionStream)));
  // Signed by the key its sender is named after, or it isn't theirs.
  const pub = bytes(signed.p), said = JSON.parse(signed.b);
  if (await idOf(pub) !== said.f || !await signedBy(pub, bytes(signed.s), `p2p-call-board|${far.room}|${signed.b}`)) return null;
  return said;
}

// Listens to the board for as long as the call lasts; a lost connection is
// reopened from where it broke off. ready is told once: it works, or it doesn't.
// The board counts every request and turns away those who make too many,
// so everything here is done with as few as can be.
function boardListen(ready) {
  // The spare boards first: it works if any one board does.
  if (ready) {
    let left = 1 + CONF.spare.length;
    const told = ready;
    ready = (ok) => {
      left--;
      if (!told.done && (ok || !left)) { told.done = true; told(ok); }
    };
    for (const url of CONF.spare) spareListen(url, ready);
  }
  // A one-time call is first asked for its past: has the organizer ended it?
  const from = mt.since || (far.exp ? '12h' : '');
  const ws = new WebSocket(`${CONF.board.replace(/^http/, 'ws')}/${mt.topic}/ws` + (from ? `?since=${from}` : ''));
  mt.sub = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    mt.wait = 3000;
    if (!mt.since) mt.since = Math.floor(Date.now() / 1000) - 2;
    if (!mt.began) mt.began = mt.since;
    if (ready) ready(true);
  };
  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.event !== 'message') return;
    mt.since = Math.max(mt.since, ev.time - 2);
    boardHeard(ev.message, ev.time < mt.began);
  };
  ws.onclose = (e) => {
    if (mt.closed || state.ended) return;
    if (!opened && ready) ready(false);
    console.warn('board: the line dropped', e.code, '— again in', mt.wait / 1000, 's');
    setTimeout(() => boardListen(), mt.wait);
    mt.wait = Math.min(mt.wait * 2, 60000);
  };
}

// past: said before we came — then only the organizer's orders still matter.
function boardHeard(text, past) {
  mt.in = mt.in.then(() => boardRead(text))
    .then((m) => m && (!past || m.k === 'order') && onBoard(m))
    .catch(() => { /* not ours, or spoilt */ });
}

function spareListen(url, ready) {
  let line = null, wait = 5000;
  const open = () => {
    if (mt.closed || state.ended) return;
    try { line = mqttOpen(url, mt.topic, boardHeard); } catch (e) { return ready && ready(false); }
    mt.spare.push(line);
    line.onready = () => {
      wait = 5000;
      if (!mt.began) mt.began = Math.floor(Date.now() / 1000) - 2;
      if (ready) ready(true);
      ready = null;
    };
    line.onclose = () => {
      mt.spare = mt.spare.filter((l) => l !== line);
      if (ready) ready(false);
      ready = null;
      setTimeout(open, wait);
      wait = Math.min(wait * 2, 60000);
    };
  };
  open();
}

async function meetConnect() {
  try {
    if (far.exp && Date.now() / 1000 > far.exp) return end('This call link no longer works: it was a one-time link.', false);
    await conf;
    await meetKeys();
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const pub = await crypto.subtle.exportKey('raw', pair.publicKey);
    mt.myKey = pair.privateKey;
    mt.myPub = b64(pub);
    const id = await idOf(pub);
    mt.mark = (await idOf(utf8.encode(`p2p-call mark|${far.room}|${clientKey}`)));
    if (mt.hostKey) mt.proof = { pub: mt.hostPub, sig: await hostSign(`p2p-call-host|${far.room}|${id}`) };
    if (!await new Promise((ready) => boardListen(ready))) throw new Error('the board is out of reach');
    if (state.ended) return;
    // What the rest of the page takes for its connection to a server: always
    // there, and "heard from" whenever it is asked (see the ping above).
    state.lastHeard = Date.now();
    state.ws = { readyState: WebSocket.OPEN, close: meetLeave };
    onMessage({
      type: 'welcome', id, name: (state.name || '').slice(0, 32) || 'Guest', host: !!mt.hostKey, peers: [], locked: false,
      invite: mt.hostKey ? CONF.site + '#' + linkTail() : '',
      config: { room: far.room, once: !!far.exp },
    });
    // was: the name we went by before this page was reloaded, so that the
    // others don't keep an empty seat for it.
    // A one-time call that its organizer has ended stays ended: the board
    // hands over its past first, and the order to end would be in it.
    if (far.exp) await sleep(800);
    if (state.ended) return;
    boardSay({ k: 'hello', info: myInfo(), was: session.get('sm.was') || '' });
    session.set('sm.was', id);
  } catch (e) {
    console.warn('meet', e);
    end('Couldn’t reach the message board people use to find each other. Check your connection and try again.');
  }
}

function meetLeave() {
  if (mt.closed) return;
  mt.closed = true;
  for (const peer of state.peers.values()) toPeer(peer, { type: 'bye' });
  if (mt.sub) mt.sub.close();
  for (const line of mt.spare) line.close();
}

// key: what a removal is remembered by. Not this browser's own key — that
// one also holds its place in calls hosted by a program, and everything said
// here is read by everyone who has the link — but a mark made from it for
// this call alone.
const myInfo = () => ({ id: state.me.id, name: state.me.name, key: mt.mark, host: mt.proof, ...mt.status });

// Why somebody isn't let in, if they aren't. Asked whichever way they come.
const refusal = (info) => (mt.banned.has(info.key) ? 'banned'
  : state.locked && !info.host ? 'locked'
  : state.peers.size >= 9 ? 'full' : '');

// What somebody says about themselves is checked before it is believed —
// above all that they are the organizer.
async function vetted(info) {
  if (!info || !/^[0-9a-f]{32}$/.test(info.id) || typeof info.key !== 'string' || info.key.length > 64) return null;
  let host = false;
  try {
    const p = info.host;
    if (p) host = await fingerprint(bytes(p.pub)) === far.room && await signedBy(bytes(p.pub), bytes(p.sig), `p2p-call-host|${far.room}|${info.id}`);
  } catch { /* not the organizer, then */ }
  return {
    id: info.id, name: String(info.name || '').slice(0, 32) || 'Guest', key: info.key, host,
    muted: !!info.muted, music: !!info.music, video: ['camera', 'screen', 'both'].includes(info.video) ? info.video : '',
  };
}

// What comes from the board. Anyone who has the link can write there, so
// nothing here is taken on trust that could harm: at most a stranger gets
// a handshake, which is what the link is for.
async function onBoard(m) {
  if (!state.me || state.ended || m.f === state.me.id || (m.to && m.to !== state.me.id)) return;
  switch (m.k) {
    case 'hello': {
      const info = await vetted(m.info);
      if (!info || info.id !== m.f) return;
      const before = typeof m.was === 'string' && state.peers.get(m.was);
      if (before && before.pc.connectionState !== 'connected') onMessage({ type: 'peer-left', id: m.was });
      if (state.peers.has(info.id)) return;
      const why = refusal(info);
      if (why) {
        // One answer is enough: whoever is first by name gives it.
        if ([...state.peers.keys()].every((id) => state.me.id < id)) boardSay({ k: 'no', to: info.id, why });
        return;
      }
      // Of any two, the one whose name comes first makes the offer — so
      // that two never offer at once, whoever came when.
      // (Our offer introduces us; otherwise we say we are here and wait for theirs.)
      if (state.me.id < info.id) {
        addPeer(info, true);
      } else {
        addPeer(info, false);
        boardSay({ k: 'here', to: info.id, info: myInfo() });
      }
      render();
      break;
    }
    case 'here': {
      const info = await vetted(m.info);
      if (info && info.id === m.f && !state.peers.has(info.id) && !refusal(info)) {
        addPeer(info, true);
        render();
      }
      break;
    }
    case 'no':
      // Believed only by one who has just come and met nobody yet.
      if (!state.peers.size) end(REJECTED[m.why] || 'You couldn’t join the call.', m.why !== 'banned');
      break;
    case 'sig': {
      if (!state.peers.has(m.f) && m.info) {
        // Somebody already in the call answers our hello with an offer.
        const info = await vetted(m.info);
        if (info && info.id === m.f && !state.peers.has(info.id) && !refusal(info)) {
          addPeer(info, false);
          render();
        }
      }
      if (state.peers.has(m.f)) onSignal(m.f, m.d);
      break;
    }
    case 'order':
      takeOrder(m.o, false);
      break;
  }
}

// The line between two pages. In every kind of call it carries the chat; in
// a call with no server — everything else that isn't sound or picture too.
function openLine(peer) {
  const dc = peer.pc.createDataChannel('room', { negotiated: true, id: 0 });
  peer.dc = dc;
  dc.onopen = () => {
    bridgeOpen(peer);
    if (meet) {
      toPeer(peer, { type: 'status', ...mt.status });
      if (state.law.length) toPeer(peer, { type: 'law', orders: state.law });
      if (state.music) tellMusic();
    }
    chatCompare(peer);
  };
  dc.onmessage = (e) => {
    if (state.peers.get(peer.info.id) !== peer) return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (bridgeWord(peer, m) || chatWord(peer, m) || !meet) return;
    const id = peer.info.id;
    switch (m.type) {
      case 'status':
        onMessage({ type: 'status', id, muted: !!m.muted, music: !!m.music, video: ['camera', 'screen', 'both'].includes(m.video) ? m.video : '' });
        break;
      case 'music-info': if (peer.info.music) onMessage({ type: 'music-info', id, data: m.data }); break;
      case 'signal': onSignal(id, m.data); break;
      case 'order': takeOrder(m.o, false); break;
      // The orders still in force, for one who came after they were given.
      case 'law': for (const o of (Array.isArray(m.orders) ? m.orders : []).slice(0, 50)) takeOrder(o, true); break;
      case 'bye': onMessage({ type: 'peer-left', id }); break;
      case 'roster':
        mt.rosters.set(id, (Array.isArray(m.who) ? m.who : []).slice(0, 20)
          .filter((x) => x && typeof x.id === 'string').map((x) => ({ id: x.id, name: String(x.name || '').slice(0, 32) })));
        compareRosters();
        break;
    }
  };
}

// With no server nobody keeps the list of who is in the call: each page knows
// only those it is connected to. So somebody with the link could show up to
// one participant alone, unseen by the rest. The pages therefore tell each
// other whom they see, and one that is seen by a friend but not by us is
// pointed out.
function tellRoster() {
  const who = [...state.peers.values()].map((p) => ({ id: p.info.id, name: p.info.name }));
  for (const peer of state.peers.values()) toPeer(peer, { type: 'roster', who });
}

function compareRosters() {
  const now = Date.now(), seen = new Set(), lines = [];
  for (const [by, who] of mt.rosters) {
    const friend = state.peers.get(by);
    if (!friend) { mt.rosters.delete(by); continue; }
    for (const x of who) {
      if (x.id === state.me.id || state.peers.has(x.id)) continue;
      seen.add(x.id);
      if (!mt.odd.has(x.id)) mt.odd.set(x.id, now);
      // Not at once: somebody just coming in is seen by one before the other.
      if (now - mt.odd.get(x.id) > 15000) lines.push(`${friend.info.name} is connected to “${x.name}”, who isn’t in your list.`);
    }
  }
  for (const id of [...mt.odd.keys()]) if (!seen.has(id)) mt.odd.delete(id);
  $('strangers').hidden = !lines.length;
  if (lines.length) {
    $('strangers').textContent = '⚠ ' + [...new Set(lines)].join(' ')
      + ' Someone with the link may have connected to only some of you. If you don’t know them, end the call and start a new one with a new link.';
  }
}
setInterval(() => {
  if (!meet || !state.me || state.ended) return;
  tellRoster();
  compareRosters();
}, 8000);

function toPeer(peer, m) {
  if (!peer.dc || peer.dc.readyState !== 'open') return false;
  try { peer.dc.send(JSON.stringify(m)); return true; } catch { return false; }
}

// What the page would tell a server goes to the other pages instead.
function meetSend(m) {
  const everyone = (what) => { for (const peer of state.peers.values()) toPeer(peer, what); };
  switch (m.type) {
    case 'ping': state.lastHeard = Date.now(); break;
    case 'status':
      for (const k of ['muted', 'music', 'video']) if (m[k] !== undefined) mt.status[k] = m[k];
      everyone({ type: 'status', ...mt.status });
      break;
    case 'music-info': everyone({ type: 'music-info', data: m.data }); break;
    case 'signal': {
      // Over the direct line while it holds; through the board when it doesn't yet, or no longer.
      const peer = state.peers.get(m.to);
      if (!peer) break;
      if (peer.pc.connectionState === 'connected' && toPeer(peer, { type: 'signal', data: m.data })) break;
      // An offer to one who has just come in also says who is offering:
      // one message on the board instead of two.
      const first = m.data.sdp && m.data.sdp.type === 'offer' && !peer.met;
      boardSay(first ? { k: 'sig', to: m.to, d: m.data, info: myInfo() } : { k: 'sig', to: m.to, d: m.data });
      break;
    }
    case 'mute': giveOrder({ a: 'mute', id: m.id }, m.id); break;
    case 'music-ctl': giveOrder({ a: 'music', id: m.id, d: m.data }, m.id); break;
    case 'lock': giveOrder({ a: 'lock', on: !!m.locked }); break;
    case 'kick': {
      const peer = state.peers.get(m.id);
      if (peer && !peer.info.host) giveOrder({ a: 'kick', id: m.id, key: peer.info.key });
      break;
    }
    case 'end': giveOrder({ a: 'end' }); break;
  }
}

// The organizer's orders: signed, so that every page can tell them from
// anybody else's wish.
async function giveOrder(what, to) {
  if (!mt.hostKey) return;
  const c = JSON.stringify({ ...what, t: Date.now() });
  const o = { c, pub: mt.hostPub, sig: await hostSign(`p2p-call-order|${far.room}|${c}`) };
  for (const peer of state.peers.values()) if (!to || peer.info.id === to) toPeer(peer, { type: 'order', o });
  // The end of the call is put on the board too: for those who aren't
  // connected just now, and for whoever opens the link afterwards.
  // (A one-time link dies with it, so the spare boards are asked to remember
  // it; a permanent one must go on working.)
  if (what.a === 'end') boardSay({ k: 'order', o }, !!far.exp);
  // Here it takes effect a moment later: first let it reach the others.
  setTimeout(() => takeOrder(o, false), what.a === 'kick' || what.a === 'end' ? 500 : 0);
}

async function readOrder(o) {
  if (!o || typeof o.c !== 'string' || o.c.length > 2000) return null;
  const pub = bytes(o.pub);
  if (await fingerprint(pub) !== far.room || !await signedBy(pub, bytes(o.sig), `p2p-call-order|${far.room}|${o.c}`)) return null;
  return JSON.parse(o.c);
}

// old: the order comes from the stock handed to a newcomer, not fresh from the organizer.
async function takeOrder(o, old) {
  try {
    const c = await readOrder(o);
    if (!c || state.ended || !state.me) return;
    // Once: an order somebody kept and sends again does nothing. Nor does
    // one from another day — a call with a permanent link is a new call each
    // time, and yesterday's lock is not today's. (A one-time call's end is
    // the exception: that one is for good.)
    if (mt.orders.has(o.c)) return;
    mt.orders.add(o.c);
    if (Date.now() - c.t > 24 * 3600 * 1000 && !(c.a === 'end' && far.exp)) return;
    const fresh = !old && Math.abs(Date.now() - c.t) < 10 * 60 * 1000;
    switch (c.a) {
      case 'kick':
        if (state.law.some((x) => x.sig === o.sig)) return;
        state.law.push(o);
        mt.banned.add(c.key);
        // Only the one named leaves: whoever merely carries the same mark may
        // have had it copied by the one being removed.
        if (c.id === state.me.id) onMessage({ type: 'kicked' });
        else if (state.peers.has(c.id)) onMessage({ type: 'peer-left', id: c.id });
        break;
      case 'lock':
        if (c.t <= mt.lockT) return;
        mt.lockT = c.t;
        state.law = state.law.filter((x) => x !== mt.lockOrder);
        mt.lockOrder = o;
        state.law.push(o);
        onMessage({ type: 'locked', locked: !!c.on });
        break;
      case 'mute': if (fresh && c.id === state.me.id) onMessage({ type: 'muted-by-host' }); break;
      case 'music': if (fresh && c.id === state.me.id) onMessage({ type: 'music-ctl', data: c.d }); break;
      // A one-time call ends for good; a permanent one only for those in it now.
      case 'end': if (fresh || far.exp) end(state.me.host ? 'Call ended.' : 'The host ended this call.', false); break;
    }
  } catch (e) {
    console.warn('order', e);
  }
}

// Nobody tells these pages that someone has dropped out for good: a
// connection that stays broken for two minutes is taken for a goodbye.
setInterval(() => {
  if (!meet || !state.me || state.ended) return;
  const now = Date.now();
  for (const peer of [...state.peers.values()]) {
    if (peer.pc.connectionState === 'connected') {
      peer.met = true;
      peer.lostAt = 0;
    } else {
      peer.lostAt = peer.lostAt || now;
      if (now - peer.lostAt > (peer.met ? 120000 : 60000)) onMessage({ type: 'peer-left', id: peer.info.id });
    }
  }
}, 5000);
