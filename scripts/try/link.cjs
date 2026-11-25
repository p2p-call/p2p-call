// A call hosted by the program, entered by its link: the link's page finds
// the call on the board, the call page seals its connection to the program
// and says the word from the link's secret.
const t = require('./lib.cjs');

(async () => {
  try {
    await t.startBoard();
    await t.startSite();
    const prog = await t.startProgram();
    t.log('link:', prog.link);
    t.check('the link carries a name and a secret', /#[\w-]{22}\.[\w-]{22}$/.test(prog.link));

    const host = await t.page('host', prog.host);
    await t.enter(host, 'Mike');
    t.check('the organizer sees the same link', await host.evaluate(() => state.invite) === prog.link);

    const a = await t.page('a', prog.link);
    await t.enter(a, 'Pete');
    const b = await t.page('b', prog.link);
    await t.enter(b, 'Vic');
    t.check('the address bar keeps nothing of the link', !/[#?]/.test(a.url()));
    t.check('everyone is connected to everyone', await t.meshed([host, a, b]));
    t.check('everyone hears everyone', await t.hears([host, a, b]));

    // A camera, switched on and off again.
    await a.evaluate(() => startVideo('camera'));
    let seen = false;
    for (let i = 0; i < 15 && !seen; i++) {
      await t.sleep(1000);
      seen = await host.evaluate(() => [...state.peers.values()].some((p) => p.info.video === 'camera' && p.tracks.camera && !p.tracks.camera.muted)
        && [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0));
    }
    t.check('a camera is seen by the others', seen);
    await a.evaluate(() => stopVideo('camera'));
    await t.sleep(1000);
    t.check('and switched off', await host.evaluate(() => [...state.peers.values()].every((p) => !p.info.video)));

    // The name alone, or the name with a wrong secret, opens nothing.
    const [room, secret] = prog.link.split('#')[1].split('.');
    const wrong = secret.split('').reverse().join('');
    const c = await t.page('c', `${t.SITE}#${room}.${wrong}`);
    await t.sleep(4000);
    t.check('a wrong secret finds no call', (await c.textContent('#text')).includes("isn't on"));
    const d = await t.page('d', `${t.SITE}#${room}`);
    await t.sleep(1000);
    t.check('the name alone is no link', (await d.textContent('#more')).includes('incomplete'));
    // Even knowing where the program is: without the word nobody is let in.
    const e = await t.page('e', `${t.SITE}c1/#` + new URLSearchParams({ r: room, s: 'http://localhost:8765', k: wrong, n: 'Stranger' }));
    await e.click('#joinBtn');
    await e.waitForSelector('#endScreen:not([hidden])', { timeout: 15000 });
    t.check('the program turns away a guest without the word', (await e.textContent('#endText')).includes('no longer works'));
    t.check('and the call goes on untouched', (await host.evaluate(() => state.peers.size)) === 2);

    // The organizer's powers still work across the sealed connection.
    const bId = await b.evaluate(() => state.me.id);
    await host.evaluate((id) => send({ type: 'kick', id }), bId);
    await b.waitForSelector('#endScreen:not([hidden])', { timeout: 10000 });
    t.check('a removed guest is out', (await a.evaluate(() => state.peers.size)) === 1);

    // The program goes away and comes back at another address: the pages
    // look the call up on the board again and go on.
    prog.kid.kill();
    await t.sleep(1500);
    const again = await t.startProgram(['-port', '8766']);
    t.check('the link is the same after a restart', again.link === prog.link);
    const host2 = await t.page('host2', again.host);
    await t.enter(host2, 'Mike');
    let moved = false;
    for (let i = 0; i < 40 && !moved; i++) {
      await t.sleep(1000);
      moved = await a.evaluate(() => state.server === 'http://localhost:8766' && state.ws && state.ws.readyState === 1 && !!state.ws.seal);
    }
    t.check('a page in the call finds the program at its new address', moved);
  } catch (e) {
    t.log('ERROR', e.stack || e);
    t.check('the scenario ran to its end', false);
  }
  await t.finish();
})();
