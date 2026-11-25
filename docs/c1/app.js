'use strict';

// Every participant connects to every other one directly (a mesh). The
// server only passes the handshakes along. To avoid two sides offering at
// once, only the newcomer makes offers: to everyone already in the call.

const $ = (id) => document.getElementById(id);

function storage(kind) {
  return {
    get(k) { try { return window[kind].getItem(k); } catch { return null; } },
    set(k, v) { try { window[kind].setItem(k, v); } catch { /* private mode */ } },
  };
}
const local = storage('localStorage');
const session = storage('sessionStorage');

// Where everything lives — the site the links lead to, the repository with
// the programs, the notice board — is written down once, in site.json beside
// this page; the organizer's program and the Android app read the same file.
// (Tried out on this computer, the page can be pointed at a board of its
// own — scripts/testboard — so as not to spend the real one's allowance.)
let CONF = { site: '', repo: '', board: '', spare: [], app: '', stun: [] };
const conf = fetch('site.json').then((r) => r.json()).then((c) => {
  if (location.hostname === 'localhost' && session.get('sm.board')) {
    c.board = session.get('sm.board');
    c.spare = session.get('sm.spare') ? [session.get('sm.spare')] : [];
  }
  // The public servers that tell a browser its address out there (see
  // site.json). The organizer's program sends its own list; until then, and
  // in a call with no program, these.
  if (Array.isArray(c.stun) && c.stun.length && !state.iceGiven) state.ice = [{ urls: c.stun }];
  return (CONF = c);
}).catch((e) => { console.warn('site.json', e); return CONF; });

// The host's link carries a token once; it is kept for this tab and taken out
// of the address bar so it doesn't end up in a screenshot or a copied link.
let hostToken = new URLSearchParams(location.search).get('host');
if (hostToken) {
  session.set('sm.host', hostToken);
  history.replaceState(null, '', location.pathname);
} else {
  hostToken = session.get('sm.host') || '';
}

// This page is served in two ways. To the organizer — by the program itself,
// on their own device. To a guest — from the permanent link's site, and then
// the call is somewhere else: behind the tunnel's address that the link's
// page has found and handed over (#r= the call's name, s= its address,
// k= the secret from the link).
// What is said between this page and the organizer's program then crosses
// somebody else's tunnel, so it is sealed (see "the sealed connection").
// Like the host's token, the address is kept for this tab only and taken
// out of the address bar — and so out of the browser's history.
//
// And there is a call with no program behind it at all, created on the
// site's page itself (#r= its name, b= its secret, x= when its link runs
// out): then the pages find each other on a public notice board and talk
// to each other directly from there on (see "a call with no server").
//
// Or the link may lead straight to the tunnel's address, with no site and
// no board on the way (#r= the name, k= the secret, and nothing else): then
// it is the program that has served this page, through the tunnel, and the
// call is where the page came from. The Android app opens such a link with
// its own copy of this page instead (s= the tunnel's address, d=1).
const arrived = new URLSearchParams(location.hash.slice(1));
const fromSite = /\/c\d+\/(index\.html)?$/.test(location.pathname);   // the site keeps this page in c1/
let far = null;   // { room, server, pass, direct } or { room, secret, exp } — set when the call isn't where this page came from
if (!hostToken) {
  if (arrived.get('r') && (arrived.get('s') || arrived.get('b') || (arrived.get('k') && !fromSite))) {
    session.set('sm.far', JSON.stringify({
      room: arrived.get('r'), server: arrived.get('s') || location.origin, pass: arrived.get('k') || '',
      secret: arrived.get('b') || '', exp: Number(arrived.get('x')) || 0,
      direct: !arrived.get('b') && (!arrived.get('s') || arrived.get('d') === '1'),
    }));
  }
  try { far = JSON.parse(session.get('sm.far') || 'null'); } catch { /* none */ }
  const there = far && (far.secret
    ? /^[A-Za-z0-9_-]{22}$/.test(far.secret)
    : /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/localhost:\d+)$/.test(far.server) && /^[A-Za-z0-9_-]{22}$/.test(far.pass));
  if (!there || !/^[A-Za-z0-9_-]{22}$/.test(far.room)) far = null;
}
const meet = !!(far && far.secret);   // the call has no server: the pages meet on the board
// The page itself came through somebody else's tunnel: it could have been
// changed on the way. The guest is told so, and where to get a page that can't be.
const throughTunnel = !!(far && far.direct && !fromSite);
// The link's tail, as people pass it on.
const linkTail = () => far.room + (meet ? '~' + far.secret + (far.exp ? '~' + far.exp.toString(36) : '') : '.' + far.pass);
// A link straight to the tunnel, to where the call is now.
const directLink = () => `${state.server}/#r=${far.room}&k=${far.pass}`;

// A random key per browser, so that someone the host removed can't just
// reload the page and come back.
let clientKey = local.get('sm.key');
if (!clientKey) {
  clientKey = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  local.set('sm.key', clientKey);
}

const state = {
  ws: null,
  name: '',
  lastHeard: 0,      // when the server last said anything
  retryTimer: 0,
  retryDelay: 1000,
  tries: 0,          // failed reconnects in a row
  room: far ? far.room : '',        // the permanent link's name for this call, if it has one
  server: far ? far.server : '',    // the call's address (when far)
  law: [],           // in a call with no server: the organizer's signed orders still in force
  me: null,          // { id, name, host, muted }
  locked: false,
  muted: false,
  stream: null,      // our microphone
  ice: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],   // until site.json says (see conf)
  iceGiven: false,   // the organizer's program has sent its own list
  peers: new Map(),  // id -> peer
  ended: false,
  audioCtx: null,
  music: null,       // the song we are playing to everyone, see startMusic
  mix: null,         // what goes out instead of the bare microphone, see mixOpen
  song: null,        // somebody else's song: { id, name, dur, pos, paused, vol, at }
  videos: { camera: null, screen: null },   // what we are showing: { track, back } each
  meLevel: null,     // analyser on our own microphone
  invite: '',
};

const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

const inApp = !window.AndroidApp && /Telegram|FBAN|FBAV|Instagram|Line\/|; wv\)/.test(navigator.userAgent);

// ------------------------------------------------------------------ get the program

// Guests are offered the program for their own system, to host calls
// themselves. Not on iPhone and iPad (nothing exists for them), not inside
// the Android app, and not to the organizer, who has it already.
(async function offerApp() {
  if (window.AndroidApp || hostToken || local.get('sm.noapp')) return;
  const latest = `https://github.com/${(await conf).repo}/releases/latest`;
  const ua = navigator.userAgent;
  let text, links;
  if (/Android/.test(ua)) {
    text = 'There’s an Android app: start your own calls and talk with the phone held to your ear.';
    links = [['Download app', 'p2p-call-android.apk']];
  } else if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return;
  } else if (/Windows/.test(ua)) {
    text = 'Want to host your own calls? Get the app for Windows.';
    links = [['Download', 'p2p-call-windows-x64.exe']];
  } else if (/Macintosh/.test(ua)) {
    text = 'Want to host your own calls? Get the app for Mac.';
    links = [['Mac with M1 or newer', 'p2p-call-mac-apple-silicon.zip'], ['Mac with Intel', 'p2p-call-mac-intel.zip']];
  } else if (/Linux/.test(ua)) {
    text = 'Want to host your own calls? Get the app for Linux.';
    links = [['Download', /aarch64|arm64/.test(ua) ? 'p2p-call-linux-arm64.tar.gz' : 'p2p-call-linux-x64.tar.gz']];
  } else {
    return;
  }
  $('getAppText').textContent = text;
  for (const [label, file] of links) {
    const a = document.createElement('a');
    a.textContent = label;
    a.href = `${latest}/download/${file}`;
    a.target = '_blank';
    a.rel = 'noopener';
    $('getAppLinks').appendChild(a);
  }
  const how = document.createElement('a');
  how.textContent = 'How to install';
  how.href = latest;
  how.target = '_blank';
  how.rel = 'noopener';
  $('getAppLinks').appendChild(how);
  $('getAppClose').onclick = () => {
    local.set('sm.noapp', '1');
    $('getApp').hidden = true;
  };
  $('getApp').hidden = false;
})();

// ------------------------------------------------------------------ joining

// The name is remembered three ways, because this page's own memory is lost
// with every new tunnel address: by the Android app, by the permanent link's
// page (which passes it along as #n=…), and here, for the organizer.
const app = window.AndroidApp;
const LEFT = 'You left the call.';   // the app knows this text: it needs no explaining
const passed = arrived.get('n');
if (location.hash.length > 1) history.replaceState(null, '', location.pathname + location.search);
$('name').value = (app && app.getName && app.getName()) || passed || local.get('sm.name') || '';
$('inAppHint').hidden = !inApp;

// A guest on Android can hand the call over to the app, if it is installed.
// A link straight to a tunnel goes whole: the app opens it with its own page.
if (/Android/.test(navigator.userAgent) && !window.AndroidApp && far) {
  conf.then((c) => {
    $('openInAppLink').href = far.direct
      ? `intent://direct/${encodeURIComponent(directLink())}#Intent;scheme=p2pcall;package=${c.app};end`
      : `intent://room/${linkTail()}#Intent;scheme=p2pcall;package=${c.app};end`;
    $('openInApp').hidden = false;
  });
}
if (throughTunnel) {
  $('tunnelHost').textContent = location.host;
  $('tunnelWarn').hidden = false;
}
$('joinBtn').onclick = join;
// In the app there is a start screen to go back to; in a browser the tab is
// simply closed.
if (app && app.callEnded) {
  $('backBtn').hidden = false;
  $('backBtn').onclick = () => app.callEnded(LEFT);
}
$('name').onkeydown = (e) => { if (e.key === 'Enter') join(); };

async function join() {
  const hint = $('joinHint');
  hint.textContent = '';
  hint.classList.remove('error');
  $('joinBtn').disabled = true;

  const name = $('name').value.trim();
  local.set('sm.name', name);
  if (app && app.setName) app.setName(name);

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
    micProblem('This browser can’t make calls.');
    return;
  }

  // What the page has to know about the call. A far one tells it in its
  // welcome, sealed; asking here would be asking the tunnel.
  if (!far) {
    try {
      const r = await fetch('config.json', { cache: 'no-store' });
      takeConfig(await r.json());
    } catch { /* keep the default STUN */ }
  }

  hint.textContent = 'Allow microphone access…';
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
    watchMic();
  } catch (e) {
    micProblem(e.name === 'NotAllowedError'
      ? 'Microphone access is blocked. Allow it in the site settings (icon left of the address) and try again.'
      : 'Couldn’t turn on the microphone: ' + e.message);
    return;
  }
  hint.textContent = 'Connecting…';

  // Created inside the tap, so the browser lets it run.
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.meLevel = analyse(state.stream);
  } catch { /* the speaking highlight is a nicety */ }

  connect(name);
}

function takeConfig(c) {
  if (!c) return;
  if (c.iceServers && c.iceServers.length) {
    state.ice = c.iceServers;
    state.iceGiven = true;
  }
  state.room = c.room || state.room;
  $('onceNote').hidden = !c.once;
  $('directNote').hidden = !c.direct;
  state.direct = !!c.direct;
}

function micProblem(text) {
  const hint = $('joinHint');
  hint.textContent = text;
  hint.classList.add('error');
  if (inApp) $('inAppHint').hidden = false;
  $('joinBtn').disabled = false;
}

// The connection to the organizer's server only introduces people; voice
// doesn't pass through it. Phones lose it all the time (a network switch, a
// tunnel hiccup), so it is reopened quietly and the server gives us our place
// back — the others never see us leave.
function connect(name) {
  if (name !== undefined) state.name = name;
  if (meet) return meetConnect();
  const ws = new WebSocket((state.server || location.origin).replace(/^http/, 'ws') + '/ws');
  ws.binaryType = 'arraybuffer';
  state.ws = ws;
  state.lastHeard = Date.now();
  const join = (pass) => send({
    type: 'join', name: state.name, key: clientKey, host: hostToken,
    resume: state.me ? state.me.id : '', pass,
  });
  const heard = (text) => {
    if (ws !== state.ws) return;
    state.lastHeard = Date.now();
    let m;
    try { m = JSON.parse(text); } catch { return; }
    onMessage(m);
  };
  if (!far) {
    ws.onopen = () => join();
    ws.onmessage = (e) => heard(e.data);
  } else {
    // First the keys (see below), then the join — sealed, like all the rest.
    const mine = crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    let myPub = '';
    ws.onopen = async () => {
      try {
        myPub = b64(await crypto.subtle.exportKey('raw', (await mine).publicKey));
        ws.send(JSON.stringify({ type: 'hello', pub: myPub }));
      } catch (e) { console.warn('hello', e); ws.close(); }
    };
    let turn = Promise.resolve();   // the answers are unsealed strictly one after another
    ws.onmessage = (e) => {
      turn = turn.then(async () => {
        if (!ws.seal) {
          ws.seal = await agree(JSON.parse(e.data), (await mine).privateKey, myPub);
          // The word from the link's secret goes with the join, sealed:
          // without it the program lets nobody in.
          const pass = (await door()).pass;
          if (ws === state.ws) join(pass);
          return;
        }
        heard(await unseal(ws.seal, e.data));
      }).catch((err) => {
        // Not the organizer on the other end, or somebody meddling: no talk.
        console.warn('sealed connection', err);
        ws.close();
      });
    };
  }
  ws.onclose = (e) => { if (ws === state.ws) onClose(e); };
}
