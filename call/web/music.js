'use strict';

// A song for everyone, mixed into the microphone.
// (One page, cut in parts: see index.html for the order they load in.)

// ------------------------------------------------------------------ music

// A song from this device, for everyone. Nothing is uploaded anywhere: the
// file plays here, and what is sent to the others becomes a live mix of the
// song and the microphone instead of the microphone alone. When the song is
// off, the microphone goes out untouched, as if none of this existed.

// What is being sent to the others right now.
function outgoing() {
  return state.mix ? state.mix.track : state.stream.getAudioTracks()[0];
}

// The mix: the microphone plus whatever else is to be heard — a song, the
// sound of a shared screen. It exists only while there is something to add;
// each user opens it and closes it again.
function mixOpen() {
  if (!state.mix) {
    const ctx = state.audioCtx;
    const out = ctx.createMediaStreamDestination();
    const mic = ctx.createMediaStreamSource(state.stream);
    mic.connect(out);
    state.mix = { out, mic, track: out.stream.getAudioTracks()[0], users: 0 };
    setOutgoing(state.mix.track);
    tuneAudio();
  }
  state.mix.users++;
  return state.mix.out;
}

function mixClose() {
  const mix = state.mix;
  if (!mix || --mix.users > 0) return;
  state.mix = null;
  mix.mic.disconnect();
  if (!state.ended) setOutgoing(state.stream.getAudioTracks()[0]);
  tuneAudio();
}

async function setOutgoing(track) {
  for (const peer of state.peers.values()) {
    // One we pass somebody's voice on to gets it mixed with ours (bridge.js).
    if (carrying(peer)) { carryRefresh(peer); continue; }
    try { await peer.audioSender.replaceTrack(track); } catch (e) { console.warn('replaceTrack', e); }
  }
}

$('musicBtn').onclick = () => $('musicFile').click();
$('musicFile').onchange = () => {
  const file = $('musicFile').files[0];
  $('musicFile').value = '';
  if (file) startMusic(file);
};

async function startMusic(file) {
  for (const peer of state.peers.values()) {
    if (peer.info.music) return toast(`${peer.info.name} is already playing music. Two songs at once is just noise.`);
  }
  if (state.music) stopMusic();
  const ctx = state.audioCtx;
  if (!ctx || !ctx.createMediaStreamDestination) return toast('This browser can’t play music into the call.');
  try { await ctx.resume(); } catch { /* play() below will tell */ }

  const el = new Audio();
  el.src = URL.createObjectURL(file);
  const song = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  gain.gain.value = $('musicVol').value / 100;
  song.connect(gain);
  gain.connect(mixOpen());        // to the others…
  gain.connect(ctx.destination);  // …and to our own ears

  state.music = { el, song, gain, name: file.name };
  el.onended = stopMusic;
  el.onerror = () => { toast('Couldn’t read this file. Try another one (mp3, m4a, ogg).'); stopMusic(); };
  el.onplay = el.onpause = () => { renderMusic(); tellMusic(); };
  el.onseeked = el.ondurationchange = () => { renderMusicTime(); tellMusic(); };
  el.ontimeupdate = renderMusicTime;
  $('musicSeek').value = 0;
  $('musicVol').value = Math.round(gain.gain.value * 100);
  send({ type: 'status', music: true });
  tellMusic();
  // Some browsers only start playing from a tap; the ▶ button is there for that.
  el.play().catch(() => {});
  render();
}

function stopMusic() {
  const m = state.music;
  if (!m) return;
  state.music = null;
  m.el.onended = m.el.onerror = m.el.onplay = m.el.onpause = m.el.ontimeupdate = m.el.ondurationchange = m.el.onseeked = null;
  m.el.pause();
  URL.revokeObjectURL(m.el.src);
  for (const node of [m.song, m.gain]) node.disconnect();
  mixClose();
  if (!state.ended) {
    send({ type: 'status', music: false });
    render();
  }
}

// The player drives our own song — or, in the organizer's hands, somebody
// else's: then every touch is sent to the song's owner, whose page obeys.
function theirSong() {
  if (state.music || !state.song || !state.me || !state.me.host) return null;
  const peer = state.peers.get(state.song.id);
  return peer && peer.info.music ? state.song : null;
}
const drive = (a, v) => send({ type: 'music-ctl', id: state.song.id, data: { a, v } });

$('musicPause').onclick = () => {
  const m = state.music, s = theirSong();
  if (m) {
    if (m.el.paused) m.el.play().catch(() => toast('Couldn’t start the music.'));
    else m.el.pause();
  } else if (s) {
    drive(s.paused ? 'play' : 'pause');
  }
};
$('musicStop').onclick = () => {
  if (state.music) stopMusic();
  else if (theirSong()) drive('stop');
};
$('musicVol').oninput = () => {
  if (state.music) state.music.gain.gain.value = $('musicVol').value / 100;
};
$('musicVol').onchange = () => {
  if (state.music) tellMusic();
  else if (theirSong()) drive('vol', $('musicVol').value / 100);
};

// The seek bar: it follows the song, except while a finger is dragging it.
let seeking = false;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Where the song in the player is: ours exactly, somebody else's by their
// last word about it and the time that has passed since.
function songClock() {
  const m = state.music, s = theirSong();
  if (m) return { dur: isFinite(m.el.duration) ? m.el.duration : 0, pos: m.el.currentTime };
  if (s) return { dur: s.dur, pos: Math.min(s.dur || Infinity, s.pos + (s.paused ? 0 : (Date.now() - s.at) / 1000)) };
  return null;
}

function renderMusicTime() {
  const c = songClock();
  if (!c) return;
  const pos = seeking && c.dur ? $('musicSeek').value / 1000 * c.dur : c.pos;
  $('musicPos').textContent = clock(pos);
  $('musicDur').textContent = c.dur ? clock(c.dur) : '–:––';
  if (!seeking) $('musicSeek').value = c.dur ? Math.round(c.pos / c.dur * 1000) : 0;
}
setInterval(() => { if (theirSong()) renderMusicTime(); }, 1000);
$('musicSeek').oninput = () => { seeking = true; renderMusicTime(); };
$('musicSeek').onchange = () => {
  const c = songClock();
  if (c && c.dur) {
    const to = $('musicSeek').value / 1000 * c.dur;
    if (state.music) state.music.el.currentTime = to;
    else if (theirSong()) { drive('seek', to); state.song.pos = to; state.song.at = Date.now(); }
  }
  seeking = false;
  renderMusicTime();
};

// What the others are told about our song, at every change and now and then
// in between (for those who came in later).
function tellMusic() {
  const m = state.music;
  if (!m || state.ended) return;
  send({ type: 'music-info', data: {
    name: m.name.slice(0, 80),
    dur: isFinite(m.el.duration) ? Math.round(m.el.duration) : 0,
    pos: Math.round(m.el.currentTime * 10) / 10,
    paused: m.el.paused,
    vol: m.gain.gain.value,
  } });
}
setInterval(tellMusic, 4000);

// The organizer's hand on our song.
function onMusicCtl(d) {
  const m = state.music;
  if (!m || !d) return;
  const v = Number(d.v);
  switch (d.a) {
    case 'pause': m.el.pause(); break;
    case 'play': m.el.play().catch(() => {}); break;
    case 'stop':
      stopMusic();
      toast('The host stopped your music.');
      return;
    case 'seek':
      if (isFinite(v) && isFinite(m.el.duration)) m.el.currentTime = Math.max(0, Math.min(m.el.duration, v));
      break;
    case 'vol':
      if (isFinite(v)) {
        m.gain.gain.value = Math.max(0, Math.min(1, v));
        $('musicVol').value = Math.round(m.gain.gain.value * 100);
      }
      break;
  }
  tellMusic();
}

// The Android app hands over a song shared to it from another app (a
// player's "Share"): the app serves the file at this address for the page.
window.appSong = async (name) => {
  if (!state.me || state.ended) return;
  try {
    const r = await fetch('/__app_song?' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const blob = await r.blob();
    startMusic(new File([blob], name, { type: blob.type }));
  } catch (e) {
    console.warn('app song', e);
    toast('Couldn’t get the song from the app.');
  }
};

function renderMusic() {
  const m = state.music;
  let other = null;
  for (const peer of state.peers.values()) if (peer.info.music) other = peer.info;
  if (state.song && (!other || other.id !== state.song.id)) state.song = null;
  const s = theirSong();   // the organizer drives it from the same player
  $('musicPlayer').hidden = !m && !s;
  $('musicBtn').hidden = !!m || !!s;
  // One song at a time: two at once is noise.
  $('musicBtn').disabled = !!other;
  $('musicNote').hidden = !other || !!m || !!s;
  $('musicPanel').hidden = !m && !s && !other;
  if (other) {
    $('musicNote').textContent = `${other.name} is playing music`
      + (state.song && state.song.name ? `: ${state.song.name}` : '.');
  }
  if (m || s) {
    $('musicName').textContent = '🎵 ' + (m ? m.name : `${s.name} — played by ${other.name}`);
    $('musicPause').textContent = (m ? m.el.paused : s.paused) ? '▶ Play' : '⏸ Pause';
    if (s && document.activeElement !== $('musicVol')) $('musicVol').value = Math.round(s.vol * 100);
    renderMusicTime();
  }
}
