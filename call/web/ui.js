'use strict';

// The buttons, and drawing what is on the page.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ controls

function setMuted(v) {
  state.muted = v;
  for (const t of state.stream.getAudioTracks()) t.enabled = !v;
  $('muteBtn').textContent = v ? '🔇' : '🎙';
  $('muteBtn').title = v ? 'Unmute' : 'Mute';
  $('muteBtn').classList.toggle('off', v);
  $('muteBtn').classList.toggle('on', !v);
  if (state.me) state.me.muted = v;
  send({ type: 'status', muted: v });
  render();
}

$('muteBtn').onclick = () => setMuted(!state.muted);

// Loudspeaker or earpiece: only the Android app can choose; a browser on a
// phone always plays a call through the loudspeaker.
const canSwitchSpeaker = !!(window.AndroidApp && window.AndroidApp.setSpeaker);
function setSpeaker(on, tellApp) {
  state.speaker = on;
  if (tellApp) window.AndroidApp.setSpeaker(on);
  $('speakerBtn').textContent = on ? '📞 Earpiece' : '🔊 Speaker';
}
$('speakerBtn').onclick = () => setSpeaker(!state.speaker, true);
// Two taps for what can't be taken back, so a stray one does no harm.
function twoTaps(btn, sure, act) {
  const text = btn.textContent;
  const red = btn.classList.contains('danger');
  let timer = 0;
  const calm = () => {
    clearTimeout(timer);
    timer = 0;
    btn.textContent = text;
    btn.classList.toggle('danger', red);
  };
  btn.onclick = () => {
    if (timer) {
      calm();
      act();
    } else if (!sure()) {
      act();
    } else {
      btn.classList.add('danger');
      timer = setTimeout(calm, 6000);
    }
  };
}
// The organizer's call lives in their app: when they leave it, the others go
// on talking but nobody new gets in — worth a warning first, and a second tap.
let leaveSure = 0;
$('leaveBtn').onclick = () => {
  const warn = app && !meet && state.me && state.me.host && state.peers.size;
  if (!warn || leaveSure) return end(LEFT);
  $('leaveBtn').classList.add('sure');
  leaveSure = setTimeout(() => { leaveSure = 0; $('leaveBtn').classList.remove('sure'); }, 6000);
  toast('You’re the host: others can keep talking without you, but no one new can join. Tap again to leave. To end it for everyone: "⋯" → "Call link" → "End call for everyone".', 6000);
};
twoTaps($('endAllBtn'), () => {
  $('endAllBtn').textContent = 'Sure? For everyone';
  return true;
}, () => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return toast('No connection to the call server — try again in a few seconds.');
  send({ type: 'end' });
});
// A far call may have moved since: the link's page knows where it is now.
$('againBtn').onclick = () => {
  if (!far) return location.reload();
  if (!far.direct) return location.replace('../#' + linkTail());
  // Straight to the tunnel: where the call is now, perhaps not where this page came from.
  const to = new URL(throughTunnel ? directLink() : `${location.pathname}#r=${far.room}&k=${far.pass}&s=${state.server}&d=1`, location.href);
  session.set('sm.far', '');
  location.replace(to.href);
  // The same page with only what follows the # changed doesn't load anew by itself.
  if (to.origin === location.origin && to.pathname === location.pathname) location.reload();
};
$('lockBtn').onclick = () => send({ type: 'lock', locked: !state.locked });

function setInvite(url) {
  const changed = !!state.invite && state.invite !== url;
  state.invite = url;
  $('inviteWait').hidden = true;
  $('inviteBox').hidden = false;
  $('inviteLink').value = url;
  $('shareBtn').hidden = !navigator.share && !window.AndroidApp;
  // A link straight to the tunnel has changed under the organizer's hands:
  // the old one leads nowhere now, and they ought to know at once.
  if (changed && state.me && state.me.host) {
    linkShow(true);
    $('tunnelState').textContent = 'Address just changed';
    $('tunnelState').parentNode.classList.remove('bad');
    toast('The tunnel address changed. Send the new link to anyone who hasn’t joined yet.', 7000);
  }
}

// ------------------------------------------------------------------ the sheet with the link

// Open while the organizer is alone — the link is what they are here for —
// and out of the way as soon as there is somebody to talk to. It can be shut
// by hand, and opened again from the menu.
let wasAlone = null, shutByHand = false;
function linkShow(on) {
  const was = !$('linkSheet').hidden;
  $('linkSheet').hidden = !on;
  if (on && !was && state.direct && state.me && state.me.host) tunnelCheck();
}
function linkAuto() {
  const alone = state.peers.size === 0;
  if (alone === wasAlone) return;
  wasAlone = alone;
  if (!alone) {
    shutByHand = false;
    linkShow(false);
  } else if (state.me.host && !shutByHand) {
    linkShow(true);
  }
}
for (const id of ['linkHide', 'linkClose']) {
  $(id).onclick = () => {
    shutByHand = state.peers.size === 0;
    linkShow(false);
  };
}
$('linkBtn').onclick = () => linkShow($('linkSheet').hidden);

// With a link straight to the tunnel: is the address still alive? The
// program is asked to look for itself through it. And if the tunnel has
// hung, it can be made to reconnect (some tunnels then give a new address,
// some the same one).
function tunnelCheck() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  $('tunnelState').textContent = 'Checking address…';
  $('tunnelState').parentNode.classList.remove('bad');
  send({ type: 'tunnel-check' });
}
$('checkBtn').onclick = tunnelCheck;
twoTaps($('moveBtn'), () => {
  $('moveBtn').textContent = 'Sure? The link may change';
  return true;
}, () => {
  $('tunnelState').textContent = 'Reconnecting tunnel…';
  $('tunnelState').parentNode.classList.remove('bad');
  send({ type: 'tunnel-renew' });
});
function tunnelSaid(m) {
  const bad = !m.ok;
  $('tunnelState').textContent = m.renewing ? 'Reconnecting tunnel…'
    : m.renewed ? (m.same ? 'Tunnel reconnected, same address: the link is unchanged.' : 'Tunnel reconnected with a new address: send the new link.')
    : m.error ? m.error
    : m.ok ? 'Address is up, just checked' : 'Address isn’t responding. Tap "Reconnect tunnel".';
  $('tunnelState').parentNode.classList.toggle('bad', bad && !m.renewing);
}

// ------------------------------------------------------------------ the menu

$('moreBtn').onclick = () => { $('morePanel').hidden = false; };
$('morePanel').addEventListener('click', (e) => {
  // Anything chosen, or a tap beside the menu, closes it; the choice of quality doesn't.
  if (e.target === $('morePanel') || e.target.closest('button')) $('morePanel').hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('morePanel').hidden = true;
  personShut();
});

// ------------------------------------------------------------------ one participant

// Opened from their tile: how the connection is doing, in words, and for
// the organizer — switch their microphone off, or remove them.
function openPerson(id) {
  const peer = state.peers.get(id);
  if (!peer) {
    // Our own tile: there is nothing to tell, only the picture to open.
    if (state.me && id === state.me.id && tiles.get(id) && tiles.get(id).cur.track) zoom(id);
    return;
  }
  state.person = id;
  kickCalm();
  personFill();
  $('personPanel').hidden = false;
}
function personShut() {
  state.person = '';
  $('personPanel').hidden = true;
}
function personFill() {
  const peer = state.peers.get(state.person);
  if (!peer) return personShut();
  const info = peer.info, t = tiles.get(info.id);
  $('personName').textContent = info.name + (info.host ? ' · host' : '');
  const via = peer.via && state.peers.get(peer.via);
  const lines = [];
  if (via) lines.push(`Voice via ${via.info.name}: the direct connection is poor.`);
  else if (peer.stalled) lines.push('Connection went silent, repairing…');
  else if (CONN_TEXT[peer.pc.connectionState]) lines.push('Connection: ' + CONN_TEXT[peer.pc.connectionState] + '.');
  if (peer.q) lines.push((peer.q.level === 'bad' ? 'Poor connection: ' : peer.q.level === 'mid' ? 'Fair connection: ' : 'Good connection: ') + qualityText(peer.q) + '.');
  if (info.muted) lines.push('Microphone is off.');
  $('personInfo').textContent = lines.join(' ');
  $('personZoom').parentNode.hidden = !(t && t.cur.track);
  $('personHost').hidden = !(state.me.host && !info.host);
  $('personMute').hidden = !!info.muted;
}
$('personClose').onclick = personShut;
$('personPanel').addEventListener('click', (e) => { if (e.target === $('personPanel')) personShut(); });
$('personZoom').onclick = () => {
  const id = state.person;
  personShut();
  zoom(id);
};
$('personMute').onclick = () => {
  send({ type: 'mute', id: state.person });
  personShut();
};
// Two taps, so a stray one doesn't throw a friend out.
let kickSure = 0;
function kickCalm() {
  clearTimeout(kickSure);
  kickSure = 0;
  $('personKick').textContent = 'Remove';
  $('personKick').classList.remove('danger');
}
$('personKick').onclick = () => {
  if (kickSure) {
    send({ type: 'kick', id: state.person });
    kickCalm();
    return personShut();
  }
  $('personKick').textContent = 'Really remove?';
  $('personKick').classList.add('danger');
  kickSure = setTimeout(kickCalm, 3000);
};

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.invite);
  } catch {
    $('inviteLink').select();
    document.execCommand('copy');
  }
  toast('Link copied');
};

$('shareBtn').onclick = () => {
  // Inside the Android app the page can't share by itself; the app does it.
  if (window.AndroidApp) return window.AndroidApp.share(state.invite);
  navigator.share({ title: 'Voice call', text: 'Join the call:', url: state.invite }).catch(() => {});
};

// again: is "Rejoin" worth offering?
function end(text, again = true) {
  $('chatPanel').hidden = true;
  if (state.ended) return;
  state.ended = true;
  if (meet) meetLeave();   // while there is still a line to say goodbye on
  // The chat goes with the one who leaves.
  state.chat = [];
  chatSeen.clear();
  renderChat();
  stopMusic();
  for (const kind of KINDS) stopVideo(kind);
  for (const id of [...state.peers.keys()]) removePeer(id);
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  clearTimeout(state.retryTimer);
  if (state.ws) state.ws.close(LEFT_CODE, 'left');
  if (state.audioCtx) state.audioCtx.close();
  renderVideos();
  $('joinScreen').hidden = true;
  $('callScreen').hidden = true;
  $('morePanel').hidden = true;
  personShut();
  document.body.classList.remove('incall', 'zoomed');
  $('endScreen').hidden = false;
  $('endText').textContent = text;
  $('againBtn').hidden = !again;
  // The program on a computer has no window; it follows its organizer out.
  $('endNote').hidden = !(hostToken && !app);
  // The app has its own start screen to go back to.
  if (window.AndroidApp && window.AndroidApp.callEnded) window.AndroidApp.callEnded(text);
}

// ------------------------------------------------------------------ drawing

const CONN_TEXT = {
  new: 'connecting…',
  connecting: 'connecting…',
  disconnected: 'connection unstable…',
  failed: 'no connection',
};

function render() {
  if (!state.me) return;
  state.me.music = !!state.music;
  renderMusic();
  renderVideos();
  for (const peer of state.peers.values()) showQuality(peer);
  $('count').textContent = 'In call: ' + (state.peers.size + 1);
  $('lockedNote').hidden = !state.locked;
  $('lockBtn').textContent = state.locked ? '🔓 Unlock call' : '🔒 Lock call';
  if (state.person) personFill();
  linkAuto();
}

function showBanner(text) {
  $('banner').textContent = text;
  $('banner').hidden = false;
}

let toastTimer = 0;
function toast(text, ms = 3500) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, ms);
}
