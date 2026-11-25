'use strict';

// The way to the organizer's program: the sealed connection across the tunnel,
// finding the call again on the notice boards when its address changes.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ the sealed connection

// A guest's words to the organizer's program cross the tunnel, which belongs
// to somebody else. So the two first agree on keys the tunnel can't learn:
// each sends a fresh public key, and the program signs the pair with the
// organizer's key — the one whose fingerprint is the call's name in the link,
// so the tunnel can't answer in the organizer's place. After that every
// message is sealed and numbered. (The program's side is call/wire.go.)

const utf8 = new TextEncoder();
const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

// The name in the link that a key answers to.
async function fingerprint(pub) {
  const print = new Uint8Array(await crypto.subtle.digest('SHA-256', pub)).slice(0, 16);
  return b64(print).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signedBy(pub, sig, text) {
  const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, utf8.encode(text));
}

async function agree(hello, myKey, myPub) {
  const pub = bytes(hello.key);
  if (hello.type !== 'hello' || await fingerprint(pub) !== state.room) throw new Error('not this call');
  if (!await signedBy(pub, bytes(hello.sig), `p2p-call-wire|${hello.pub}|${myPub}`)) throw new Error('not the organizer');
  const theirs = await crypto.subtle.importKey('raw', bytes(hello.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, myKey, 256);
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const key = (purpose, use) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(purpose) },
    base, { name: 'AES-GCM', length: 256 }, false, [use]);
  return {
    out: await key('p2p-call page to host', 'encrypt'), outN: 0, outTurn: Promise.resolve(),
    in: await key('p2p-call host to page', 'decrypt'), inN: 0,
  };
}

// Messages are numbered instead of carrying a random mark each: one that is
// dropped, repeated or out of turn then fails to open.
function numbered(n) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, n);
  return { name: 'AES-GCM', iv };
}

async function unseal(seal, data) {
  if (typeof data === 'string') throw new Error('an unsealed message');
  return new TextDecoder().decode(await crypto.subtle.decrypt(numbered(seal.inN++), seal.in, data));
}

function sendSealed(ws, text) {
  const seal = ws.seal, n = seal.outN++;
  seal.outTurn = seal.outTurn.then(async () => {
    const sealed = await crypto.subtle.encrypt(numbered(n), seal.out, utf8.encode(text));
    if (ws.readyState === WebSocket.OPEN) ws.send(sealed);
  }).catch((e) => { console.warn('seal', e); ws.close(); });
}

function reconnect() {
  if (state.ended || state.retryTimer) return;
  showBanner('Lost connection to the host, reconnecting… You can keep talking with everyone already here.');
  state.retryTimer = setTimeout(() => {
    state.retryTimer = 0;
    relocate().then(() => connect(), () => connect());
  }, state.retryDelay);
  state.retryDelay = Math.min(state.retryDelay + 1000, 5000);
}

// The organizer's tunnel gets a new address every time it reconnects, and
// then nobody answers at the old one any more. The address of the moment is
// on the board, signed by the organizer; a page that can't get through looks
// it up and goes on from there — from the same page, so the call isn't lost.
async function relocate() {
  state.tries++;
  // A link straight to the tunnel has no board to look on: the organizer's
  // page says where the call has gone (see 'moved' in bridge.js).
  if (!far || meet || far.direct || state.tries < 2) return;
  const n = await lookup(await conf, state.room, await door());
  if (!n || state.ended) return;
  if (n.u === '') {
    showBanner('The host ended the call. You can keep talking with everyone already here, but no one new can join.');
  } else if (n.u !== (state.server || location.origin)) {
    state.server = n.u;
  }
}

// What the link's secret gives (the program's side is identity.go): the
// board's name for the call, the key its notices are sealed with, and the
// word to say at the door. The secret itself goes nowhere.
// (The same code, down to "end of the shared code", lives in docs/index.html
// and call/web/link.js; a test keeps them alike.)
async function doorKeys(room, secret) {
  const raw = Uint8Array.from(atob(secret.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const from = (purpose) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(`p2p-call door ${purpose}|${room}`) });
  const word = async (purpose) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.deriveBits(from(purpose), base, 128))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    key: await crypto.subtle.deriveKey(from('key'), base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']),
    topic: 'p2pcall_' + await word('topic'),
    pass: await word('pass'),
  };
}
let doorOnce = null;
const door = () => doorOnce || (doorOnce = doorKeys(far.room, far.pass));

// The spare boards are public MQTT servers: the same notices go there too,
// so that one board being down, or having had enough of this address for
// today, doesn't keep people out. What they are shown is what the first
// board is shown — sealed, and under a name made from the link's secret.
// This is all of their language that is needed: listen to one name, say
// under it, and keep the line from going quiet. heard(text, kept): kept —
// said before we came, the server's one remembered message.
function mqttOpen(url, topic, heard) {
  const enc = new TextEncoder();
  const str = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
  const packet = (head, body) => {
    const len = [];
    let n = body.length;
    do { const d = n % 128; n = Math.floor(n / 128); len.push(n ? d | 128 : d); } while (n);
    const out = new Uint8Array(1 + len.length + body.length);
    out[0] = head;
    out.set(len, 1);
    out.set(body, 1 + len.length);
    return out;
  };
  const ws = new WebSocket(url, 'mqtt');
  ws.binaryType = 'arraybuffer';
  let buf = new Uint8Array(0), beat = 0;
  const line = {
    ready: false, onready: null, onclose: null,
    say(text, keep) {
      if (!line.ready || ws.readyState !== 1) return false;
      ws.send(packet(keep ? 0x31 : 0x30, [...str(topic), ...enc.encode(text)]));
      return true;
    },
    close() { line.onclose = null; clearInterval(beat); ws.close(); },
  };
  ws.onopen = () => ws.send(packet(0x10, [...str('MQTT'), 4, 2, 0, 60,
    ...str('p' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join(''))]));
  ws.onmessage = (e) => {
    // A packet may come in pieces, or several at once.
    const add = new Uint8Array(e.data), all = new Uint8Array(buf.length + add.length);
    all.set(buf);
    all.set(add, buf.length);
    buf = all;
    for (;;) {
      let i = 1, n = 0, m = 1, d;
      do {
        if (i >= buf.length) return;
        if (i > 4) return ws.close();
        d = buf[i++];
        n += (d & 127) * m;
        m *= 128;
      } while (d & 128);
      if (n > 300000) return ws.close();
      if (buf.length < i + n) return;
      const head = buf[0], body = buf.slice(i, i + n);
      buf = buf.slice(i + n);
      if (head >> 4 === 2) {            // let in: now listen to our name
        if (body[1] !== 0) return ws.close();
        ws.send(packet(0x82, [0, 1, ...str(topic), 0]));
        beat = setInterval(() => { if (ws.readyState === 1) ws.send(Uint8Array.of(0xc0, 0)); }, 30000);
      } else if (head >> 4 === 9) {     // listening
        line.ready = true;
        if (line.onready) line.onready();
      } else if (head >> 4 === 3) {     // somebody said something
        const name = (body[0] << 8) | body[1];
        try { heard(new TextDecoder().decode(body.subarray(2 + name)), !!(head & 1)); } catch { /* not ours */ }
      }
    }
  };
  ws.onclose = () => { clearInterval(beat); line.ready = false; if (line.onclose) line.onclose(); };
  return line;
}

// What a spare board remembers under the name: a list of texts, or null if
// the board couldn't be reached.
function spareRead(url, topic) {
  return new Promise((done) => {
    const got = [];
    let line = null, over = false;
    const finish = (ok) => {
      if (over) return;
      over = true;
      if (line) line.close();
      done(ok ? got : null);
    };
    try { line = mqttOpen(url, topic, (text) => got.push(text)); } catch { return finish(false); }
    // The remembered message comes right after the board starts listening.
    line.onready = () => setTimeout(() => finish(true), 700);
    line.onclose = () => finish(false);
    setTimeout(() => finish(false), 6000);
  });
}

// Reads the organizer's latest notice from the boards: { u: the call's
// address ("" — the call is over), t: when it was posted }, or null if there
// is none. c — where the boards are (site.json). The notices are sealed with
// the key from the link's secret. Whoever has the link can write there too,
// so only notices signed with the key the link names (room is that key's
// fingerprint) count.
async function lookup(c, room, keys) {
  const newest = async (texts, best) => {
    for (const text of texts) {
      try {
        const all = Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
        const n = JSON.parse(new TextDecoder().decode(
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, keys.key, all.slice(12))));
        if ((!best || n.t > best.t) && await genuine(room, n)) best = { u: n.u, t: n.t, v: n.v };
      } catch { /* not ours */ }
    }
    return best;
  };
  const spare = (c.spare || []).map((url) => spareRead(url, keys.topic));
  let best = null, failed = false;
  try {
    const r = await fetch(`${c.board}/${keys.topic}/json?poll=1&since=12h`, { cache: 'no-store' });
    if (!r.ok) throw new Error('board ' + r.status);
    const texts = [];
    for (const line of (await r.text()).split('\n')) {
      try {
        const ev = JSON.parse(line);
        if (ev.event === 'message') texts.push(ev.message);
      } catch { /* an empty line */ }
    }
    best = await newest(texts, null);
  } catch (e) {
    failed = true;
  }
  // The first board knows where the call is: no need to wait for the others.
  if (best && best.u) return best;
  const others = await Promise.all(spare);
  if (failed && others.every((o) => o === null)) throw new Error('no board answers');
  return newest(others.flat().filter((text) => text !== null), best);
}

async function genuine(room, n) {
  // (An address on this very computer is taken only by a page that is itself
  // being tried out there.)
  const here = location.hostname === 'localhost' && /^http:\/\/localhost:\d+$/.test(n.u);
  if (typeof n.u !== 'string' || typeof n.t !== 'number' || !(here || /^(https:\/\/[a-z0-9.-]+)?$/.test(n.u))) return false;
  // v — which call page speaks to the organizer's program — is signed too.
  // A signed notice can be kept and put up again later, so an old one
  // doesn't count.
  if (!Number.isInteger(n.v) || n.v < 1 || Math.abs(Date.now() / 1000 - n.t) > 24 * 3600) return false;
  const pub = Uint8Array.from(atob(n.k), (c) => c.charCodeAt(0));
  const print = new Uint8Array(await crypto.subtle.digest('SHA-256', pub)).slice(0, 16);
  const name = btoa(String.fromCharCode(...print)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (name !== room) return false;
  const key = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(atob(n.s), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(`p2p-call|${n.u}|${n.t}|${n.v}`));
}

// end of the shared code

// A dead connection can look open for minutes. The server answers every
// ping; if it has been silent for too long, drop the connection ourselves.
setInterval(() => {
  if (!state.me || state.ended || state.retryTimer) return;
  const ws = state.ws;
  if (ws.readyState === WebSocket.OPEN && Date.now() - state.lastHeard < 25000) {
    send({ type: 'ping' });
  } else if (Date.now() - state.lastHeard >= 25000) {
    state.ws = null;
    ws.close();
    reconnect();
  }
}, 10000);

window.addEventListener('online', () => {
  if (!state.me || state.ended || !state.retryTimer) return;
  clearTimeout(state.retryTimer);
  state.retryTimer = 0;
  connect();
});

// Closing the tab is leaving for real: tell the server not to hold our place.
// It is said with the way the connection is closed — that goes out at once,
// where a sealed message would still be in the making.
const LEFT_CODE = 4002;
window.addEventListener('pagehide', () => { if (state.ws) state.ws.close(LEFT_CODE, 'left'); });

function send(m) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (meet) meetSend(m);
  else if (!far) ws.send(JSON.stringify(m));
  else if (ws.seal) sendSealed(ws, JSON.stringify(m));
}

const REJECTED = {
  locked: 'The host locked the call.',
  full: 'The call is full.',
  banned: 'The host removed you from this call.',
  unsealed: 'This call is joined via the host’s link: ask for it and open it.',
  nolink: 'This call link no longer works: the host changed it. Ask for the new one.',
};

function onClose(e) {
  if (state.ended) return;
  // Somebody who was removed can't come back, so isn't offered to.
  if (e.code === 4000) return end(REJECTED[e.reason] || 'You couldn’t join the call.', e.reason !== 'banned');
  if (e.code === 4001) return end('The host removed you from the call.', false);
  if (!state.me) return end('Couldn’t connect. The call may have ended.');
  reconnect();
}
