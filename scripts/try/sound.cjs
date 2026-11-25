// The sound: a song goes out in stereo and at twice the voice's rate, and
// every connection shows how it is doing.
const t = require('./lib.cjs');

// What one page sends to the other and gets from it, in sound.
const audio = (p) => p.evaluate(async () => {
  const peer = [...state.peers.values()][0];
  const stats = await peer.pc.getStats();
  const out = { most: peer.audioSender.getParameters().encodings[0].maxBitrate };
  for (const r of stats.values()) {
    if (r.kind !== 'audio') continue;
    if (r.type === 'outbound-rtp') out.sent = r.bytesSent;
    if (r.type === 'inbound-rtp') { out.got = r.bytesReceived; out.takes = (stats.get(r.codecId) || {}).sdpFmtpLine || ''; }
  }
  return out;
});
const rate = async (p, what) => {
  const a = await audio(p);
  await t.sleep(4000);
  const b = await audio(p);
  return Math.round((b[what] - a[what]) * 8 / 4 / 1000);
};

(async () => {
  try {
    await t.startBoard();
    await t.startSite();
    const prog = await t.startProgram();
    const host = await t.page('host', prog.host);
    await t.enter(host, 'Mike');
    const a = await t.page('a', prog.link);
    await t.enter(a, 'Pete');
    t.check('connected', await t.meshed([host, a]));
    await t.sleep(1500);

    // Spare copies of the sound in every packet (RED), where the browser knows it.
    const red = await a.evaluate(async () => {
      const peer = [...state.peers.values()][0];
      const m = /m=audio \d+ \S+ (\d+)/.exec(peer.pc.currentLocalDescription.sdp);
      const first = m && new RegExp(`a=rtpmap:${m[1]} ([^/\\s]+)`).exec(peer.pc.currentLocalDescription.sdp);
      let sent = '';
      (await peer.pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'audio') sent = r.codecId; });
      const stats = await peer.pc.getStats();
      return { first: first && first[1], sends: (stats.get(sent) || {}).mimeType, fec: /useinbandfec=1/.test(peer.pc.currentLocalDescription.sdp) };
    });
    t.log('  red:', JSON.stringify(red));
    // (Chrome's numbers name the codec inside, Opus; that RED is at work shows in the traffic, about twice a bare voice's.)
    t.check('sound goes with spare copies (RED) and Opus FEC', /red/i.test(red.first || '') && red.fec);

    const before = await audio(a);
    t.log('  the guest takes:', before.takes);
    t.check('each side takes stereo and up to 128 kbit/s', /stereo=1/.test(before.takes) && /maxaveragebitrate=128000/.test(before.takes));
    t.check('a voice is sent at no more than 64 kbit/s', (await audio(host)).most === 64000 && before.most === 64000);
    const voice = await rate(host, 'sent');
    t.log('  voice:', voice, 'kbit/s');

    // A song: five seconds of stereo noise, the hardest thing to squeeze.
    await host.evaluate(() => {
      const rate = 48000, n = rate * 12, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
      const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true);
      v.setUint16(32, 4, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 4, true);
      for (let i = 0; i < n * 2; i++) v.setInt16(44 + i * 2, (Math.random() * 2 - 1) * 12000, true);
      return startMusic(new File([buf], 'noise.wav', { type: 'audio/wav' }));
    });
    await t.sleep(1500);
    t.check('with a song the limit is 128 kbit/s', (await audio(host)).most === 128000);
    const song = await rate(host, 'sent');
    t.log('  song:', song, 'kbit/s; the guest gets', await rate(a, 'got'), 'kbit/s');
    t.check('the song really goes out at more than a voice does', song > 90 && song > voice + 20);
    await host.evaluate(() => stopMusic());
    await t.sleep(500);
    t.check('and back to 64 when it is over', (await audio(host)).most === 64000);

    await t.sleep(3500);
    const dot = await a.evaluate(() => {
      const d = document.querySelector('#stage .tile .q');
      return d ? { cls: d.className, hidden: d.hidden, lag: [...state.peers.values()][0].q.lag } : null;
    });
    t.log('  the dot:', JSON.stringify(dot));
    t.check('the connection shows how it is doing', !!dot && !dot.hidden && /good|mid|bad/.test(dot.cls));
    t.check('how late the sound is gets measured', dot.lag > 0.005 && dot.lag < 1);
    // Sound that has fallen far behind is started anew.
    const anew = await a.evaluate(() => {
      const peer = [...state.peers.values()][0], was = peer.audio.srcObject;
      peer.q = { ...peer.q, lag: 5 };
      catchUp(peer);
      catchUp(peer);
      return peer.audio.srcObject !== was && !!peer.caughtUp;
    });
    await t.sleep(3000);
    t.check('sound far behind is started anew, and still heard', anew && await t.hears([host, a]));
  } catch (e) {
    t.log('ERROR', e.stack || e);
    t.check('the scenario ran to its end', false);
  }
  await t.finish();
})();
