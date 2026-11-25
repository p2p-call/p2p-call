// When the way between two guests breaks: it is noticed within seconds, the
// handshake that mends it goes through the third one, and meanwhile the third
// one carries the voice.
const t = require('./lib.cjs');

// What a page gets in sound from each of the others, in bytes so far.
const got = (p) => p.evaluate(async () => {
  const out = {};
  for (const peer of state.peers.values()) {
    let bytes = 0;
    (await peer.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') bytes += r.bytesReceived; });
    out[peer.info.name] = bytes;
  }
  return out;
});
const growth = async (p) => {
  const a = await got(p);
  await t.sleep(3000);
  const b = await got(p);
  const out = {};
  for (const k of Object.keys(b)) out[k] = b[k] - (a[k] || 0);
  return out;
};
const peerOf = (p, name) => p.evaluate((n) => {
  const peer = [...state.peers.values()].find((x) => x.info.name === n);
  return peer && { via: peer.via, stalled: !!peer.stalled, muted: peer.audio.muted, state: peer.pc.connectionState, pub: !!peer.pub };
}, name);

// Cut the way between this page and the one named: nothing more goes to them
// on the line, and no sound. (Pages on one computer can't lose a real route.)
const cut = (p, name) => p.evaluate((n) => {
  const peer = [...state.peers.values()].find((x) => x.info.name === n);
  window.cutOff = peer.info.id;
  if (!window.realToPeer) {
    window.realToPeer = toPeer;
    toPeer = (x, m) => (x.info.id === window.cutOff ? false : window.realToPeer(x, m));
  }
  peer.audioSender.replaceTrack(null);
}, name);
const mend = (p, name) => p.evaluate((n) => {
  const peer = [...state.peers.values()].find((x) => x.info.name === n);
  window.cutOff = '';
  carryRefresh(peer);
}, name);

(async () => {
  try {
    await t.startBoard();
    await t.startSite();
    const prog = await t.startProgram();
    const host = await t.page('host', prog.host);
    await t.enter(host, 'Mike');
    const a = await t.page('a', prog.link);
    await t.enter(a, 'Ann');
    const b = await t.page('b', prog.link);
    await t.enter(b, 'Bob');
    t.check('three connected', await t.meshed([host, a, b]));
    await t.sleep(2500);

    const ice = await a.evaluate(() => JSON.stringify(state.ice));
    t.log('  ice:', ice);
    t.check('several STUN servers, of different owners', /google/.test(ice) && /cloudflare/.test(ice) && /twilio/.test(ice));
    t.check('the pages have told each other their keys', (await peerOf(a, 'Bob')).pub && (await peerOf(b, 'Ann')).pub);

    // Somebody Ann doesn't count as being in the call gets no voice of hers from Mike.
    const stranger = await host.evaluate(() => {
      const a = [...state.peers.values()].find((x) => x.info.name === 'Ann'), b = [...state.peers.values()].find((x) => x.info.name === 'Bob');
      const knows = a.knows;
      a.knows = [];
      bridgeWord(b, { type: 'carry', of: a.info.id, on: true });
      const refused = !state.carry.has(b.info.id);
      a.knows = knows;
      return refused;
    });
    t.check('a voice is carried only to one its owner knows to be in the call', stranger);

    // Ann and Bob lose each other; Mike hears both.
    const at = Date.now();
    await cut(a, 'Bob');
    await cut(b, 'Ann');
    let seen = 0;
    for (let i = 0; i < 20 && !seen; i++) {
      await t.sleep(500);
      if ((await peerOf(b, 'Ann')).stalled) seen = Date.now() - at;
    }
    t.log('  noticed in', seen, 'ms');
    t.check('a dead way is noticed within five seconds', seen > 0 && seen < 5000);

    let via = null;
    for (let i = 0; i < 20; i++) {
      await t.sleep(500);
      via = await peerOf(b, 'Ann');
      if (via.via) break;
    }
    t.log('  Bob about Ann:', JSON.stringify(via));
    t.check('Ann\'s voice comes to Bob through Mike, the direct line kept quiet', !!via.via && via.muted);
    // (Ann asks for Bob's voice on her own, maybe a moment later.)
    let carried = [];
    for (let i = 0; i < 12 && carried.length < 2; i++) {
      if (i) await t.sleep(500);
      carried = await host.evaluate(() => [...state.carry.entries()].map(([to, s]) => [state.peers.get(to).info.name, [...s].map((id) => state.peers.get(id).info.name)]));
    }
    t.log('  Mike carries:', JSON.stringify(carried));
    t.check('Mike carries each one\'s voice to the other', carried.length === 2);
    const g = await growth(b);
    t.log('  Bob gets in 3 s:', JSON.stringify(g));
    t.check('Bob still gets sound from Mike (with Ann in it), none from Ann directly', g['Mike'] > 3000 && g['Ann'] < 500);
    const listed = await b.evaluate(() => document.querySelector('#stage').textContent);
    t.check('the list says so', /via Mike/.test(listed));

    // Mike stops carrying (he no longer hears Ann well, say): Bob is told,
    // goes back to the direct line at once, and asks again.
    await host.evaluate(() => {
      const a = [...state.peers.values()].find((x) => x.info.name === 'Ann'), b = [...state.peers.values()].find((x) => x.info.name === 'Bob');
      state.carry.get(b.info.id).delete(a.info.id);
      state.carry.delete(b.info.id);
      carryRefresh(b);
      carryOver(b.info.id, a.info.id);
    });
    await t.sleep(400);
    const dropped = await peerOf(b, 'Ann');
    t.check('told that the carrying has stopped, Bob unmutes the direct line', !dropped.via && !dropped.muted);
    let again = null;
    for (let i = 0; i < 16; i++) {
      await t.sleep(500);
      again = await peerOf(b, 'Ann');
      if (again.via) break;
    }
    t.check('and asks again, the way being still dead', !!again.via && again.muted);

    // The handshake that mends it: with the organizer's program out of reach
    // for these two, it goes through Mike.
    for (const p of [a, b]) {
      await p.evaluate(() => {
        window.viaCount = 0;
        const realSend = send;
        send = (m) => { if (m.type !== 'signal') realSend(m); };
        const realOnSignal = onSignal;
        onSignal = (from, data) => { window.viaCount++; realOnSignal(from, data); };
      });
    }
    await mend(a, 'Bob');
    await mend(b, 'Ann');
    await b.evaluate(() => {
      const peer = [...state.peers.values()].find((x) => x.info.name === 'Ann');
      peer.lastRestart = 0;
      restart(peer);
    });
    await t.sleep(4000);
    const viaA = await a.evaluate(() => window.viaCount);
    const after = await peerOf(b, 'Ann');
    t.log('  handshake messages that reached Ann through Mike:', viaA, '; Bob about Ann:', JSON.stringify(after));
    t.check('a fresh handshake got across through the third one', viaA >= 1 && after.state === 'connected');

    // Good again for a while: back to the direct line.
    let back = null;
    for (let i = 0; i < 30; i++) {
      await t.sleep(1000);
      back = await peerOf(b, 'Ann');
      if (!back.via) break;
    }
    t.log('  later:', JSON.stringify(back));
    t.check('back to the direct line once it is good', !back.via && !back.muted && !back.stalled);
    await t.sleep(1500);
    const carriedLater = await host.evaluate(() => state.carry.size);
    t.check('and Mike stops carrying', carriedLater === 0);
    const g2 = await growth(b);
    t.log('  Bob gets in 3 s:', JSON.stringify(g2));
    t.check('Bob hears Ann directly again', g2['Ann'] > 3000);
  } catch (e) {
    t.log('ERROR', e.stack || e);
    t.check('the scenario ran to its end', false);
  }
  await t.finish();
})();
