'use strict';

// What the server (or the board) says, the microphone, and the direct
// connections to the other participants.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ messages

function onMessage(m) {
  switch (m.type) {
    case 'welcome':
      // Also comes after a long outage, when the server has given our place
      // away: everyone is met anew then.
      for (const id of [...state.peers.keys()]) removePeer(id);
      back();
      if (state.me) wakeMic();
      takeConfig(m.config);
      state.me = { id: m.id, name: m.name, host: m.host, muted: false };
      state.locked = m.locked;
      $('joinScreen').hidden = true;
      $('callScreen').hidden = false;
      document.body.classList.add('incall');
      $('hostOnly').hidden = !m.host;
      // The link: the organizer is given it; a guest knows the one they came by.
      $('linkBtn').hidden = !m.host && !far;
      if (m.invite) setInvite(m.invite);
      else if (far) conf.then((c) => setInvite(far.direct ? directLink() : c.site + '#' + linkTail()));
      for (const p of m.peers) addPeer(p, true);
      setMuted(state.muted);
      if (state.music || videoStatus()) send({ type: 'status', music: !!state.music, video: videoStatus() });
      // The app may be holding a song shared to it before the call began.
      if (window.AndroidApp && window.AndroidApp.joined) window.AndroidApp.joined();
      if (canSwitchSpeaker) {
        // A call starts on the loudspeaker (or the headphones, if any);
        // nothing is forced until the button is pressed.
        $('speakerBtn').hidden = false;
        setSpeaker(true, false);
      }
      render();
      break;
    case 'resumed':
      back();
      send({ type: 'status', muted: state.muted, music: !!state.music, video: videoStatus() });
      wakeMic();
      // The network that dropped the server has likely dropped the direct
      // connections too.
      for (const peer of state.peers.values()) if (bad(peer.pc)) heal(peer, 0);
      break;
    case 'peer-joined':
      addPeer(m.peer, false);
      render();
      break;
    case 'peer-left':
      removePeer(m.id);
      tuneVideo();
      render();
      break;
    case 'signal':
      onSignal(m.from, m.data);
      break;
    case 'status': {
      const p = state.peers.get(m.id);
      if (p) { p.info.muted = m.muted; p.info.music = m.music; p.info.video = m.video || ''; render(); }
      break;
    }
    case 'locked':
      state.locked = m.locked;
      render();
      break;
    case 'invite':
      setInvite(m.url);
      // A link straight to the tunnel changes with the tunnel's address; the
      // pages already in the call are told the new one over the lines
      // between us — the old address no longer leads anywhere.
      tellMoved();
      break;
    case 'tunnel':
      tunnelSaid(m);
      break;
    case 'muted-by-host':
      setMuted(true);
      toast('The host muted you. Unmute with the button below.');
      break;
    case 'music-info': {
      const d = m.data || {};
      state.song = {
        id: m.id, name: String(d.name || 'Song').slice(0, 80), dur: Number(d.dur) || 0, pos: Number(d.pos) || 0,
        paused: !!d.paused, vol: Math.max(0, Math.min(1, Number(d.vol) || 0)), at: Date.now(),
      };
      renderMusic();
      break;
    }
    case 'music-ctl':
      onMusicCtl(m.data);
      break;
    case 'kicked':
      end('The host removed you from the call.', false);
      break;
    case 'ended':
      end(state.me && state.me.host ? 'Call ended.' : 'The host ended the call.', false);
      break;
  }
}

function back() {
  state.retryDelay = 1000;
  state.tries = 0;
  $('banner').hidden = true;
}

// ------------------------------------------------------------------ microphone

// A phone can quietly take the microphone away — while the browser is in the
// background, during a network switch, when another app wants it — and not
// give it back: the person looks present and unmuted but isn't heard. So
// whenever something of the kind may have happened, the microphone is
// nudged (what switching it off and on by hand does), or opened anew if the
// phone has closed it for good.
let wakingMic = false;
async function wakeMic() {
  if (!state.me || state.ended || wakingMic) return;
  wakingMic = true;
  try {
    const track = state.stream.getAudioTracks()[0];
    if (track && track.readyState === 'live') {
      if (!state.muted) {
        track.enabled = false;
        await new Promise((r) => setTimeout(r, 300));
        track.enabled = !state.muted;
      }
      return;
    }
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: MIC, video: false });
    const t = fresh.getAudioTracks()[0];
    t.enabled = !state.muted;
    state.stream = fresh;
    if (state.mix) {
      // The song goes on; only the microphone in the mix is swapped.
      state.mix.mic.disconnect();
      state.mix.mic = state.audioCtx.createMediaStreamSource(fresh);
      state.mix.mic.connect(state.mix.out);
    } else {
      await setOutgoing(t);
    }
    watchMic();
    try {
      if (state.meLevel) state.meLevel.source.disconnect();
      state.meLevel = analyse(fresh);
    } catch { /* nicety */ }
  } catch (e) {
    console.warn('microphone', e);
    toast('Your microphone dropped. Turn it off and on with the button below, or rejoin the call.');
  } finally {
    wakingMic = false;
  }
}

function watchMic() {
  const track = state.stream.getAudioTracks()[0];
  if (!track) return;
  track.onended = wakeMic;
  track.onunmute = wakeMic;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wakeMic();
});

// ------------------------------------------------------------------ peers

function addPeer(info, initiator) {
  if (state.peers.has(info.id)) return;
  const pc = new RTCPeerConnection({ iceServers: state.ice });
  const audio = document.createElement('audio');
  audio.autoplay = true;
  $('audios').appendChild(audio);

  const peer = {
    info, pc, initiator, audio, queue: Promise.resolve(), level: null, healTimer: 0, lastRestart: 0,
    audioSender: null,
    inTrack: null,                            // their voice, as it comes
    born: Date.now(), heardAt: Date.now(),    // see bridge.js
    via: '', asked: '', sees: [],
    tx: { camera: null, screen: null },       // the lines we send pictures on
    tracks: { camera: null, screen: null },   // the pictures coming from them
  };
  state.peers.set(info.id, peer);

  peer.audioSender = pc.addTrack(outgoing(), state.stream);
  spareSound(pc, peer.audioSender);
  // Two lines for video are laid at once, empty — the first for a camera,
  // the second for a screen: a picture is then put on its line and taken off
  // without a new handshake. The side that offers lays them here; the other
  // side finds them in the offer (see onSignal).
  if (initiator) {
    for (const kind of KINDS) {
      peer.tx[kind] = pc.addTransceiver('video', { direction: 'sendrecv' });
      const v = state.videos[kind];
      if (v) peer.tx[kind].sender.replaceTrack(v.track).catch((e) => console.warn('video', e));
    }
  }

  // A line of their own between the two pages, for words: the chat always,
  // and with no server everything else that isn't sound or picture. It is
  // agreed on in the same handshake.
  openLine(peer);

  pc.onicecandidate = (e) => {
    // Through the board a handshake goes whole, routes and all (see offer).
    if (e.candidate && !meet) signal(info.id, { candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      // Which of the two it is, the order of the lines tells.
      const kind = KINDS[videoLines(pc).indexOf(e.transceiver)];
      if (kind) peer.tracks[kind] = e.track;
      renderVideos();
      return;
    }
    const stream = new MediaStream([e.track]);
    peer.inTrack = e.track;
    // A voice this page passes on to somebody (bridge.js) now comes as this track.
    for (const [to, ids] of state.carry) if (ids.has(info.id)) carryRefresh(state.peers.get(to));
    audio.srcObject = stream;
    play(audio);
    try { peer.level = analyse(stream); } catch { /* nicety */ }
  };
  pc.onconnectionstatechange = () => {
    report(peer);
    if (pc.connectionState === 'connected') { peer.everConnected = true; peer.heardAt = Date.now(); tuneVideo(); tuneAudio(); }
    if (bad(pc)) heal(peer, 2000);
    render();
  };

  if (initiator) run(peer, () => offer(peer, false));
}

// Sound that survives lost packets. Opus itself tucks a rough copy of each
// moment into the next packet (FEC, "useinbandfec=1" in the description; the
// browsers say it by themselves), which covers a packet lost here and there.
// RED goes further: every packet carries the one or two before it whole, so
// even a few lost in a row are made up from those that come — at about twice
// the voice's traffic, which for a voice is little. It is put first among the
// ways this side takes and sends sound; a browser that doesn't know it
// (Firefox, as yet) simply agrees on bare Opus.
function spareSound(pc, sender) {
  try {
    const line = pc.getTransceivers().find((t) => t.sender === sender);
    const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('audio');
    if (!line || !line.setCodecPreferences || !caps) return;
    const red = caps.codecs.filter((c) => /^audio\/red$/i.test(c.mimeType));
    if (!red.length) return;
    line.setCodecPreferences([...red, ...caps.codecs.filter((c) => !/^audio\/red$/i.test(c.mimeType))]);
  } catch (e) {
    console.warn('red', e);
  }
}

function bad(pc) {
  return pc.connectionState === 'disconnected' || pc.connectionState === 'failed';
}

// A direct connection that broke (the phone moved from Wi-Fi to mobile data,
// say) is given fresh routes, again and again until it is back. Only the side
// that offered makes the new offer, so the two never offer at once; the other
// side asks it to. The handshake goes by every way there is (signal, in
// bridge.js): through the organizer's program, or the board, and through
// whoever else is connected to both.
function heal(peer, after) {
  if (peer.healTimer) return;
  peer.healTimer = setTimeout(() => {
    peer.healTimer = 0;
    if (state.peers.get(peer.info.id) !== peer || !broken(peer)) return;
    if (peer.initiator) restart(peer);
    else signal(peer.info.id, { restart: true });
    // The board is not ours to flood: there the tries are far between —
    // unless somebody else can pass the handshake on.
    heal(peer, meet && !(peer.pub && helpers(peer).length) ? 40000 : 8000);
  }, after);
}

function restart(peer) {
  if (Date.now() - peer.lastRestart < 3000) return;
  peer.lastRestart = Date.now();
  run(peer, () => offer(peer, true));
}

// Tells the organizer's window how this direct connection is doing — the
// only place where "the sound dropped" can be looked up afterwards.
async function report(peer) {
  let text = peer.pc.connectionState;
  if (text === 'connected') {
    try {
      const stats = await peer.pc.getStats();
      for (const r of stats.values()) {
        if (r.type !== 'candidate-pair' || !r.nominated || r.state !== 'succeeded') continue;
        const l = stats.get(r.localCandidateId), rem = stats.get(r.remoteCandidateId);
        if (l && rem) text += ` (${l.candidateType}/${l.protocol} → ${rem.candidateType})`;
        break;
      }
    } catch { /* the state alone will do */ }
  }
  send({ type: 'diag', text: `↔ ${peer.info.name}: ${text}` });
}

// Handshake steps for one peer run strictly one after another.
function run(peer, step) {
  peer.queue = peer.queue.then(step).catch((e) => console.warn('peer', peer.info.id, e));
}

async function offer(peer, iceRestart) {
  await setLocal(peer.pc, await peer.pc.createOffer({ iceRestart }));
  if (meet) await routesFound(peer.pc);
  signal(peer.info.id, { sdp: hiFi(peer.pc.localDescription) });
}

// Each message on the board counts, so there a handshake waits until the
// browser has found all its routes and takes them along, instead of sending
// them after one by one.
function routesFound(pc) {
  return new Promise((done) => {
    if (pc.iceGatheringState === 'complete') return done();
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, 4000);
  });
}

// Browsers send voice at about 32 kbit/s, in one channel, unless the
// listener asks for more. Each side says in its description that it takes up
// to 128 kbit/s and stereo — room enough for a song. How much is really sent
// is the sender's choice (tuneAudio): a voice alone doesn't need that much.
function hiFi(desc) {
  const sdp = desc.sdp.replace(/^a=fmtp:(\d+) (.*useinbandfec=1.*)$/gm, (line, pt, params) =>
    /maxaveragebitrate/.test(params) ? line
      : `a=fmtp:${pt} ${params.replace(/;?\s*s?prop-stereo=\d|;?\s*stereo=\d/g, '')};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`);
  return { type: desc.type, sdp };
}

// The browser has to hear it of itself too, or it plays the song it gets
// in one channel. One that won't have its description touched keeps its own.
async function setLocal(pc, desc) {
  try {
    await pc.setLocalDescription(hiFi(desc));
  } catch (e) {
    console.warn('description as the browser made it', e);
    await pc.setLocalDescription(desc);
  }
}

// A voice goes out at 64 kbit/s: clear, and light enough for ten people on
// mobile data. With a song in the mix (or a shared screen's sound) — 128.
function tuneAudio() {
  const most = state.mix ? 128000 : 64000;
  for (const peer of state.peers.values()) {
    try {
      const params = peer.audioSender.getParameters();
      if (!params.encodings || !params.encodings.length) continue;   // not agreed on yet
      params.encodings[0].maxBitrate = most;
      peer.audioSender.setParameters(params).catch(() => {});
    } catch { /* the browser's own choice will do */ }
  }
}

// ------------------------------------------------------------------ how the connections are doing

// "I hear you badly" has a cause that can be seen: packets lost on the way,
// or a long way round. Every few seconds each direct connection is asked,
// and the answer is shown beside the person: a dot, and words when it is
// poor. loss — the share of sound lost, either way; rtt — there and back, ms;
// lag — how long their sound waits here before it is played, s.
const QUALITY_EVERY = 3000;
setInterval(async () => {
  if (!state.me || state.ended) return;
  for (const peer of state.peers.values()) {
    let q = null;
    if (peer.pc.connectionState === 'connected') {
      try { q = await measure(peer); } catch { /* next time */ }
    } else {
      peer.counted = null;
    }
    const was = peer.q ? peer.q.level : '';
    peer.q = q;
    catchUp(peer);
    showQuality(peer);
    // The organizer's window keeps a note, to look up afterwards.
    if (q && q.level === 'bad' && was !== 'bad') send({ type: 'diag', text: `↔ ${peer.info.name}: ${qualityText(q)}` });
  }
}, QUALITY_EVERY);

// Sound that has fallen behind — a browser short of breath lets it pile up,
// and then everything is heard seconds late — is given a fresh start: what
// has piled up is dropped, and playing goes on from now. Not more often
// than twice a minute, and only if it stays behind for two looks in a row.
function catchUp(peer) {
  const late = peer.q && peer.q.lag >= 1.5;
  peer.lateLooks = late ? (peer.lateLooks || 0) + 1 : 0;
  if (peer.lateLooks < 2 || Date.now() - (peer.caughtUp || 0) < 30000) return;
  peer.caughtUp = Date.now();
  peer.lateLooks = 0;
  send({ type: 'diag', text: `↔ ${peer.info.name}: audio lagged ${peer.q.lag.toFixed(1)} s, restarting playback` });
  const stream = peer.audio.srcObject;
  if (!stream) return;
  try {
    // Asked to keep as little in store as it can…
    for (const r of peer.pc.getReceivers()) if (r.track && r.track.kind === 'audio' && 'jitterBufferTarget' in r) r.jitterBufferTarget = 0;
  } catch { /* an old browser */ }
  // …and the player itself is started anew.
  peer.audio.srcObject = null;
  peer.audio.srcObject = new MediaStream(stream.getAudioTracks());
  play(peer.audio);
}

async function measure(peer) {
  const stats = await peer.pc.getStats();
  let rtt = null, lost = 0, got = 0, theirLoss = 0;
  let waited = 0, played = 0, outWaited = 0, outPlayed = 0;
  for (const r of stats.values()) {
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
      if (r.currentRoundTripTime !== undefined) rtt = r.currentRoundTripTime * 1000;
    } else if (r.type === 'inbound-rtp' && r.kind === 'audio') {
      lost = r.packetsLost || 0;
      got = r.packetsReceived || 0;
      // How long the sound sat in the browser's buffer, summed over all of it.
      waited = r.jitterBufferDelay || 0;
      played = r.jitterBufferEmittedCount || 0;
    } else if (r.type === 'media-playout') {
      // And how long more on its way out to the speaker.
      outWaited = r.totalPlayoutDelay || 0;
      outPlayed = r.totalSamplesCount || 0;
    } else if (r.type === 'remote-inbound-rtp' && r.kind === 'audio') {
      // What they say about the sound they get from us.
      if (r.fractionLost !== undefined) theirLoss = r.fractionLost;
      if (rtt === null && r.roundTripTime !== undefined) rtt = r.roundTripTime * 1000;
    }
  }
  // Lost since the last look, not since the call began.
  const before = peer.counted || { lost, got, waited, played, outWaited, outPlayed };
  peer.counted = { lost, got, waited, played, outWaited, outPlayed };
  const share = (a, b) => (b > 0 && a >= 0 ? a / b : 0);
  const lag = share(waited - before.waited, played - before.played) + share(outWaited - before.outWaited, outPlayed - before.outPlayed);
  const dLost = Math.max(0, lost - before.lost), dGot = Math.max(0, got - before.got);
  const now = Math.max(dLost + dGot >= 20 ? dLost / (dLost + dGot) : 0, theirLoss);
  // Evened out over a few looks, so that one hiccup doesn't raise an alarm.
  const loss = peer.q ? peer.q.loss * 0.5 + now * 0.5 : now;
  const level = loss >= 0.08 || rtt >= 700 || lag >= 1.5 ? 'bad' : loss >= 0.02 || rtt >= 300 || lag >= 0.6 ? 'mid' : 'good';
  return { loss, rtt, lag, level };
}

function qualityText(q) {
  const parts = [];
  if (q.loss >= 0.005) parts.push(`${Math.max(1, Math.round(q.loss * 100))}% audio lost`);
  if (q.rtt !== null) parts.push(`${Math.round(q.rtt)} ms delay`);
  if (q.lag >= 0.4) parts.push(`audio ${q.lag.toFixed(1)} s behind`);
  return parts.join(', ') || 'no loss';
}

// Only the dot on their tile is touched (and the sheet about them, if it is
// open): the rest may be in the middle of something.
function showQuality(peer) {
  const t = tiles.get(peer.info.id);
  if (!t) return;
  const q = peer.q;
  t.dot.className = 'q ' + (q ? q.level : '');
  t.dot.hidden = !q;
  if (state.person === peer.info.id) personFill();
}

function onSignal(from, data) {
  const peer = state.peers.get(from);
  if (!peer || !data || !signalOnce(data)) return;
  run(peer, async () => {
    const pc = peer.pc;
    if (data.restart) {
      if (peer.initiator) restart(peer);
    } else if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        if (!peer.tx.camera) {
          // The offer brought the lines for video; make them ours to send on too.
          const lines = videoLines(pc);
          for (const [i, kind] of KINDS.entries()) {
            if (!lines[i]) continue;
            peer.tx[kind] = lines[i];
            lines[i].direction = 'sendrecv';
            if (state.videos[kind]) await lines[i].sender.replaceTrack(state.videos[kind].track);
          }
        }
        await setLocal(pc, await pc.createAnswer());
        if (meet) await routesFound(pc);
        signal(from, { sdp: hiFi(pc.localDescription) });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { console.warn('candidate', e); }
    }
  });
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  state.peers.delete(id);
  clearTimeout(peer.healTimer);
  carryForget(id);
  if (peer.carryMix) for (const n of peer.carryMix.nodes) n.disconnect();
  peer.pc.close();
  peer.tracks = { camera: null, screen: null };
  peer.audio.srcObject = null;
  peer.audio.remove();
  if (peer.level) peer.level.source.disconnect();
}

function play(audio) {
  const p = audio.play();
  if (p && p.catch) p.catch(() => { $('unlockAudio').hidden = false; });
}

$('unlockAudio').onclick = () => {
  for (const peer of state.peers.values()) play(peer.audio);
  if (state.audioCtx) state.audioCtx.resume();
  $('unlockAudio').hidden = true;
};

// ------------------------------------------------------------------ who's talking

function analyse(stream) {
  const source = state.audioCtx.createMediaStreamSource(stream);
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  return { source, analyser, data: new Uint8Array(analyser.fftSize) };
}

function speaking(level) {
  if (!level) return false;
  level.analyser.getByteTimeDomainData(level.data);
  let sum = 0;
  for (const v of level.data) sum += (v - 128) * (v - 128);
  return Math.sqrt(sum / level.data.length) > 6;
}

setInterval(() => {
  if (!state.me || state.ended) return;
  for (const [key, t] of tiles) {
    if (key.includes(':')) continue;   // a screen says nothing
    const on = key === state.me.id
      ? !state.muted && speaking(state.meLevel)
      : speaking(state.peers.get(key) && state.peers.get(key).level);
    t.el.classList.toggle('speaking', on);
  }
}, 200);
