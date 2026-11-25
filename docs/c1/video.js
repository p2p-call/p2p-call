'use strict';

// The camera and the shared screen.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ video

// A camera and a screen, for everyone. Like the voice they go straight to
// each of the others, so whoever shows a picture sends it once per viewer:
// the more people there are, the lighter each copy is made, so that the voice
// never has to make room for it.

const KINDS = ['camera', 'screen'];
const CAMERA = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
// What all the copies of a picture may weigh together, and one copy at most, kbit/s.
const BUDGET = { camera: [2400, 1500], screen: [3000, 2500] };
// The camera's quality is the person's own choice: the top one is the most
// the page will send, and the network may still push it lower by itself.
// [how many times smaller the picture, share of the budget]
const QUALITY = { high: [1, 1], mid: [1.5, 0.5], low: [3, 0.2] };
let quality = QUALITY[local.get('sm.quality')] ? local.get('sm.quality') : 'high';
$('quality').value = quality;
$('quality').onchange = () => {
  quality = QUALITY[$('quality').value] ? $('quality').value : 'high';
  local.set('sm.quality', quality);
  tuneVideo();
};
const mobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
// Phones' browsers can't share a screen; the Android app can't either.
const canShareScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !mobile && !window.AndroidApp;
$('screenBtn').hidden = !canShareScreen;

function videoLines(pc) {
  return pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video');
}

// What the others are told we are showing.
function videoStatus() {
  const { camera, screen } = state.videos;
  return camera && screen ? 'both' : camera ? 'camera' : screen ? 'screen' : '';
}
const shows = (info, kind) => info.video === kind || info.video === 'both';

async function sendVideo(kind, track) {
  for (const peer of state.peers.values()) {
    if (!peer.tx[kind]) continue;
    try { await peer.tx[kind].sender.replaceTrack(track); } catch (e) { console.warn('video', e); }
  }
}

const startingVideo = {};
async function startVideo(kind, back) {
  if (startingVideo[kind] || !state.me || state.ended) return;
  startingVideo[kind] = true;
  try {
    // A phone can't hold two cameras open, so the old one goes first. A
    // screen stays on, though, until another one has really been chosen.
    if (kind === 'camera' && state.videos.camera) dropVideoTrack('camera');
    let stream;
    if (kind === 'screen') {
      stream = await shareScreen();
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...CAMERA, facingMode: back ? 'environment' : 'user' },
      });
    }
    const track = stream.getVideoTracks()[0];
    if (state.ended) return track.stop();
    if (state.videos[kind]) dropVideoTrack(kind);
    try { track.contentHint = kind === 'screen' ? 'detail' : 'motion'; } catch { /* a hint only */ }
    // "Stop sharing" in the browser's own bar, or the phone taking the camera away.
    track.onended = () => { if (state.videos[kind] && state.videos[kind].track === track) stopVideo(kind); };
    state.videos[kind] = { track, back: !!back, sound: null };
    // A screen may come with its sound (the browser offers a tick for it,
    // where it can): it joins what the others hear from us.
    const heard = stream.getAudioTracks()[0];
    if (heard && state.audioCtx && state.audioCtx.createMediaStreamDestination) {
      try {
        const source = state.audioCtx.createMediaStreamSource(new MediaStream([heard]));
        source.connect(mixOpen());
        state.videos[kind].sound = { source, track: heard };
        toast('Everyone hears your screen audio too. Use headphones, or friends will hear an echo.', 6000);
      } catch (e) {
        console.warn('screen sound', e);
        heard.stop();
      }
    } else if (heard) {
      heard.stop();
    }
    await sendVideo(kind, track);
    tuneVideo();
  } catch (e) {
    console.warn('video', e);
    const denied = e && e.name === 'NotAllowedError';
    if (kind === 'screen') {
      if (!denied) toast('Couldn’t share the screen: ' + e.message);
    } else {
      toast(denied ? cameraDenied() : 'Couldn’t turn on the camera: ' + e.message, 8000);
      // The other camera didn't open, and the first one is gone already.
      if (!state.videos.camera && !state.ended) sendVideo('camera', null);
    }
  } finally {
    startingVideo[kind] = false;
    if (!state.ended) send({ type: 'status', video: videoStatus() });
    render();
  }
}

// Why the camera wasn't given, and what to do about it — which depends on
// where the page is open.
function cameraDenied() {
  if (app && !app.canVideo) {
    // The page comes from the organizer and may be newer than the app showing it.
    return 'The app didn’t provide the camera. It’s probably outdated: leave the call and tap "Update available" on the start screen. If it’s up to date, allow the camera in phone settings: Apps → p2p-call → Permissions.';
  }
  if (app) return 'Camera access is blocked for the app. Allow it in phone settings: Apps → p2p-call → Permissions → Camera.';
  if (inApp) return 'The camera isn’t available here. Open the link in your regular browser: menu ⋮ or … → "Open in browser".';
  return 'Camera access is blocked. Allow it in the site settings (icon left of the address) and try again. On a phone, also check that the browser itself is allowed to use the camera.';
}

function dropVideoTrack(kind) {
  const v = state.videos[kind];
  state.videos[kind] = null;
  v.track.onended = null;
  v.track.stop();
  if (v.sound) {
    v.sound.source.disconnect();
    v.sound.track.stop();
    mixClose();
  }
}

// The screen, with its sound where the browser can give it. The sound is
// taken as it is — it is music or a film, not a voice to be cleaned up —
// and without this page's own sound, or everyone would hear themselves.
async function shareScreen() {
  const video = { frameRate: { ideal: 12, max: 20 } };
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true };
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio });
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) throw e;   // the person said no
    return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  }
}

function stopVideo(kind) {
  if (!state.videos[kind]) return;
  dropVideoTrack(kind);
  if (state.ended) return;
  sendVideo(kind, null);
  send({ type: 'status', video: videoStatus() });
  tuneVideo();
  render();
}

// How much each viewer's copy of a picture may weigh: its budget, shared
// between the viewers.
function tuneVideo() {
  const n = Math.max(1, state.peers.size);
  for (const kind of KINDS) {
    if (!state.videos[kind]) continue;
    const [shrink, share] = kind === 'camera' ? QUALITY[quality] : [1, 1];
    const [all, one] = BUDGET[kind];
    const kbps = Math.max(120, Math.min(one, Math.max(250, all / n)) * share);
    for (const peer of state.peers.values()) {
      if (!peer.tx[kind]) continue;
      try {
        const sender = peer.tx[kind].sender;
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) continue;   // not agreed on yet
        params.encodings[0].maxBitrate = Math.round(kbps * 1000);
        params.encodings[0].scaleResolutionDownBy = shrink;
        // When the network is short, a screen keeps its sharpness and loses
        // smoothness; a face the other way round.
        params.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'maintain-framerate';
        sender.setParameters(params).catch(() => {});
      } catch { /* the browser's own limits will do */ }
    }
  }
}

$('camBtn').onclick = () => {
  if (state.videos.camera) stopVideo('camera');
  else startVideo('camera', false);
};
$('screenBtn').onclick = () => {
  if (state.videos.screen) stopVideo('screen');
  else startVideo('screen');
};

// Everybody in the call is a tile — with their camera's picture in it, or
// the first letter of their name — and so is every screen that is shown.
// Tiles are kept from one drawing to the next, so that the video in them
// doesn't blink.
const tiles = new Map();   // a participant's id, or "id:screen" -> { el, video, avatar, name, ic, dot, flip, track, cur }
let bigTile = '';          // the tile opened on the whole window, if any
const wideWindow = window.matchMedia('(min-width: 700px)');
if (wideWindow.addEventListener) wideWindow.addEventListener('change', () => renderVideos());
// A computer's window: tiles keep a camera's shape and, all the same size,
// are laid out as large as the stage allows, in the middle of it.
const deskWindow = window.matchMedia('(min-width: 900px)');
if (deskWindow.addEventListener) deskWindow.addEventListener('change', () => renderVideos());
if (window.ResizeObserver) new ResizeObserver(() => fitTiles()).observe(document.getElementById('stage'));

function fitTiles() {
  const main = $('stageMain');
  if (!main) return;
  const n = [...main.children].filter((e) => !e.classList.contains('corner')).length, stage = $('stage');
  const free = deskWindow.matches && n > 0 && !stage.classList.contains('screens');
  main.classList.toggle('fit', free);
  if (!free) { main.style.gridAutoRows = ''; main.style.justifyContent = main.style.alignContent = ''; return; }
  const W = main.clientWidth, H = main.clientHeight, gap = 10, shape = 16 / 9;
  let best = 0, cols = 1;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const w = Math.min((W - gap * (c - 1)) / c, (H - gap * (rows - 1)) / rows * shape);
    if (w > best) { best = w; cols = c; }
  }
  // Too many to fit at a useful size: two columns' worth and scroll.
  const scroll = best < 220;
  if (scroll) { cols = Math.max(1, Math.floor((W + gap) / (220 + gap))); best = (W - gap * (cols - 1)) / cols; }
  best = Math.floor(best);
  main.style.gridTemplateColumns = `repeat(${cols}, ${best}px)`;
  main.style.gridAutoRows = `${Math.floor(best / shape)}px`;
  main.style.justifyContent = 'center';
  main.style.alignContent = scroll ? 'start' : 'center';
}

const stagePart = (id) => {
  let el = $(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    $('stage').appendChild(el);
  }
  return el;
};

// A colour of one's own for the circle with the letter, the same on every page.
function tint(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 45% 45%)`;
}

function makeTile(key) {
  const t = {
    el: document.createElement('div'), video: document.createElement('video'), avatar: document.createElement('div'),
    name: document.createElement('div'), ic: document.createElement('div'), dot: document.createElement('span'),
    flip: null, track: null, cur: null,
  };
  t.video.autoplay = true;
  t.video.muted = true;         // the voice comes separately
  t.video.playsInline = true;
  t.avatar.className = 'avatar';
  t.name.className = 'tile-name';
  t.ic.className = 'tile-ic';
  t.dot.className = 'q';
  t.dot.hidden = true;
  t.el.append(t.video, t.avatar, t.name, t.ic);
  // A tap opens a picture on the whole window; where there is none, and on
  // a long press anywhere, it tells about the person.
  let held = 0, wasHeld = false;
  const letGo = () => { clearTimeout(held); held = 0; };
  t.el.addEventListener('pointerdown', () => {
    wasHeld = false;
    letGo();
    held = setTimeout(() => { wasHeld = true; openPerson(t.cur.id); }, 550);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) t.el.addEventListener(ev, letGo);
  t.el.addEventListener('contextmenu', (e) => { e.preventDefault(); letGo(); wasHeld = true; openPerson(t.cur.id); });
  t.el.onclick = () => {
    if (wasHeld) { wasHeld = false; return; }
    if (bigTile === key) zoom('');
    else if (t.cur.track) zoom(key);
    else openPerson(t.cur.id);
  };
  tiles.set(key, t);
  return t;
}

function renderVideos() {
  const want = new Map();  // key -> { id, kind, track, mine, info, peer }
  if (!state.ended && state.me) {
    const add = (info, peer, cam, scr) => {
      want.set(info.id, { id: info.id, kind: 'camera', track: cam || null, mine: !peer, info, peer });
      if (scr) want.set(info.id + ':screen', { id: info.id, kind: 'screen', track: scr, mine: !peer, info, peer });
    };
    for (const peer of state.peers.values()) {
      add(peer.info, peer, shows(peer.info, 'camera') && peer.tracks.camera, shows(peer.info, 'screen') && peer.tracks.screen);
    }
    const { camera, screen } = state.videos;
    add(state.me, null, camera && camera.track, screen && screen.track);
  }
  for (const [key, t] of tiles) {
    if (want.has(key)) continue;
    if (bigTile === key) zoom('');
    t.video.srcObject = null;
    t.el.remove();
    tiles.delete(key);
  }

  const main = stagePart('stageMain'), strip = stagePart('stageStrip');
  const screens = [...want.values()].filter((w) => w.kind === 'screen').length;
  const people = want.size - screens;
  let pictures = 0;
  for (const [key, w] of want) {
    const t = tiles.get(key) || makeTile(key);
    t.cur = w;
    if (t.track !== w.track) {
      t.track = w.track;
      t.video.srcObject = w.track ? new MediaStream([w.track]) : null;
      if (w.track) {
        const p = t.video.play();
        if (p && p.catch) p.catch(() => {});
      }
    }
    if (w.track) pictures++;
    t.video.hidden = !w.track;
    t.avatar.hidden = !!w.track;
    t.avatar.textContent = (w.info.name || '?').trim().slice(0, 1).toUpperCase() || '?';
    t.avatar.style.background = tint(w.info.id);
    const back = w.mine && w.kind === 'camera' && state.videos.camera && state.videos.camera.back;
    t.el.className = 'tile' + (w.kind === 'screen' ? ' screen' : '') + (w.mine ? ' mine' : '') + (back ? ' back' : '')
      + (w.track ? ' has-video' : '') + (bigTile === key ? ' big' : '')
      + (!screens && people === 2 && w.mine ? ' corner' : '')
      + (t.el.classList.contains('speaking') ? ' speaking' : '');

    // Its name, and in a few words how the way to them is doing.
    let words = w.kind === 'screen' ? `Screen: ${w.mine ? 'yours' : w.info.name}` : w.info.name + (w.mine ? ' (you)' : '');
    let bad = false;
    if (w.peer && w.kind !== 'screen') {
      const via = w.peer.via && state.peers.get(w.peer.via);
      const how = via ? `voice via ${via.info.name}` : w.peer.stalled ? 'connection silent, repairing…' : CONN_TEXT[w.peer.pc.connectionState];
      if (how) words += ' · ' + how;
      bad = w.peer.pc.connectionState === 'failed';
    }
    t.name.textContent = words;
    t.name.className = 'tile-name' + (bad ? ' bad' : '');
    t.ic.textContent = w.kind === 'screen' ? '' : (w.info.music ? '🎵' : '') + (w.info.muted ? '🔇' : '');
    if (w.peer && w.kind !== 'screen') t.ic.appendChild(t.dot);

    // My own camera, on a phone: the other one of the two.
    const flips = w.mine && w.kind === 'camera' && !!w.track && mobile;
    if (flips && !t.flip) {
      t.flip = document.createElement('button');
      t.flip.className = 'small flip';
      t.flip.textContent = '🔄';
      t.flip.title = 'Switch camera';
      for (const ev of ['pointerdown', 'click']) t.flip.addEventListener(ev, (e) => e.stopPropagation());
      t.flip.addEventListener('click', () => { if (state.videos.camera) startVideo('camera', !state.videos.camera.back); });
      t.el.append(t.flip);
    }
    if (t.flip) t.flip.hidden = !flips;

    // With a screen shown, the people line up beneath it.
    const place = screens && w.kind !== 'screen' ? strip : main;
    if (t.el.parentNode !== place) place.appendChild(t.el);
  }
  // How many across: as few as fills the stage well.
  const n = screens || people, wide = wideWindow.matches;
  const corner = !screens && people === 2;
  const cols = n <= 1 || corner ? 1 : screens ? (wide ? Math.min(n, 2) : 1) : wide ? (n <= 4 ? 2 : n <= 9 ? 3 : 4) : 2;
  main.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  strip.hidden = !screens;
  $('stage').classList.toggle('many', !screens && people > (wide ? 12 : 6));
  $('stage').classList.toggle('screens', !!screens);
  fitTiles();

  const { camera, screen } = state.videos;
  $('camBtn').classList.toggle('on', !!camera);
  $('camBtn').title = camera ? 'Turn off camera' : 'Turn on camera';
  $('screenBtn').textContent = screen ? '🖥 Stop sharing' : '🖥 Share screen';
  $('qualityRow').hidden = !camera;

  // The app keeps the camera alive in the background, and when it is left
  // with pictures on the screen it shrinks to a small window instead of hiding.
  const now = `${pictures > 0}/${!!camera}`;
  if (app && app.video && now !== toldApp) {
    toldApp = now;
    app.video(pictures > 0, !!camera);
  }
}
let toldApp = 'false/false';

// The app has become a small window over other apps (or a whole one again):
// in the small one there is room for the pictures only.
window.appPip = (on) => document.body.classList.toggle('pip', !!on);

// A tap on a picture opens it on the whole window — and, where the browser
// can, on the whole screen; another tap (or Esc) puts it back.
function zoom(key) {
  bigTile = key;
  for (const [k, t] of tiles) t.el.classList.toggle('big', k === key);
  document.body.classList.toggle('zoomed', !!key);
  if (window.AndroidApp) return;   // the app's window is the whole screen already
  const root = document.documentElement;
  const full = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (key && !full) {
      const p = (root.requestFullscreen || root.webkitRequestFullscreen || (() => {})).call(root);
      if (p && p.catch) p.catch(() => {});
    } else if (!key && full) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
  } catch { /* the whole window will do */ }
}
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(ev, () => {
    if (bigTile && !(document.fullscreenElement || document.webkitFullscreenElement)) zoom('');
  });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bigTile) zoom(''); });
