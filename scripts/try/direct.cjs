// A link straight to the tunnel: the page comes from the program itself, with
// a warning; the talk with the program is sealed all the same; a wrong secret
// is turned away; and when the tunnel's address changes, the organizer's page
// tells the guests where the call has gone.
// (No site and no board here at all: the program is started with -relay none.)
const t = require('./lib.cjs');

function startDirect() {
  return new Promise((done, fail) => {
    const lines = [];
    let host = '', link = '';
    t.run(process.env.P2P_BIN, ['-tunnel', 'self', '-relay', 'none', '-no-browser', '-port', '8765'], (l) => {
      lines.push(l);
      const h = /http:\/\/localhost:\d+\/\?host=\w+/.exec(l), k = /http:\/\/localhost:8765\/#r=\S+/.exec(l);
      if (h) host = h[0];
      if (k) link = k[0];
      if (host && link) done({ host, link, lines });
    });
    setTimeout(() => fail(new Error('the program did not start:\n' + lines.join('\n'))), 15000);
  });
}

(async () => {
  try {
    const prog = await startDirect();
    t.log('  link:', prog.link);
    t.check('the link carries the name and the secret after the #', /#r=[\w-]{22}&k=[\w-]{22}$/.test(prog.link));
    const host = await t.page('host', prog.host);
    await t.enter(host, 'Mike');
    t.check('the organizer is told the link goes straight to the tunnel', await host.isVisible('#directNote'));
    t.check('the organizer is shown that very link', (await host.inputValue('#inviteLink')) === prog.link);

    // Is the address alive? The program looks for itself through it.
    await host.click('#checkBtn');
    await host.waitForFunction(() => /Address is up/.test(document.querySelector('#tunnelState').textContent), null, { timeout: 15000 });
    t.check('the organizer can check that the address is alive', true);
    await host.click('#moveBtn');
    await host.click('#moveBtn');
    await host.waitForFunction(() => /can.t be reconnected/.test(document.querySelector('#tunnelState').textContent), null, { timeout: 5000 });
    t.check('and is told plainly when this tunnel cannot be reconnected from here', true);

    const a = await t.page('a', prog.link);
    await a.waitForSelector('#name');
    t.check('a guest is warned the page came through a tunnel', await a.isVisible('#tunnelWarn'));
    t.check('the address is gone from the address bar', !/#/.test(a.url()));
    await t.enter(a, 'Ann');
    const b = await t.page('b', prog.link);
    await t.enter(b, 'Bob');
    t.check('three connected', await t.meshed([host, a, b]));
    t.check('and hear each other', await t.hears([host, a, b]));
    t.check('the sheet with the link has gone out of the way', await host.isHidden('#linkSheet'));
    await a.click('#moreBtn');
    await a.click('#linkBtn');
    t.check('a guest has the link too, and nothing of the organizer\'s',
      (await a.inputValue('#inviteLink')) === prog.link && await a.isHidden('#hostOnly'));
    await a.click('#linkClose');
    t.check('the guests talk to the program sealed', await a.evaluate(() => !!(state.ws && state.ws.seal)));

    // A wrong secret: not let in.
    const wrong = prog.link.replace(/k=[\w-]{22}/, 'k=' + 'A'.repeat(22));
    const c = await t.page('c', wrong);
    await c.fill('#name', 'Stranger');
    await c.click('#joinBtn');
    await c.waitForSelector('#endScreen:not([hidden])', { timeout: 15000 });
    t.log('  with a wrong secret:', await c.textContent('#endText'));
    t.check('a wrong secret is turned away', /link/i.test(await c.textContent('#endText')));

    // The tunnel has moved: Ann has lost the way to the program and knows no other…
    await a.evaluate(() => {
      state.server = 'http://localhost:9';
      state.tries = 0;
      state.ws.close();
    });
    await t.sleep(3000);
    t.check('Ann has lost the program', await a.evaluate(() => !$('banner').hidden));
    // …until the organizer's page hears the new address and passes it on.
    await host.evaluate((url) => onMessage({ type: 'invite', url }), prog.link);
    let back = false;
    for (let i = 0; i < 20 && !back; i++) {
      await t.sleep(1000);
      back = await a.evaluate(() => state.server === 'http://localhost:8765' && state.ws.readyState === 1 && $('banner').hidden);
    }
    t.check('told the new address by the organizer, Ann is back with the program', back);
    t.check('still all connected', await t.meshed([host, a, b], 10000));

    // Out and in again: the same page, loaded anew, with the call still known to it.
    await b.click('#leaveBtn');
    await b.waitForSelector('#endScreen:not([hidden])', { timeout: 10000 });
    await b.click('#againBtn');
    await b.waitForSelector('#joinScreen:not([hidden]) #name', { timeout: 15000 });
    await t.enter(b, 'Bob');
    t.check('"Rejoin" brings a guest back in', await t.meshed([host, a, b], 20000));
  } catch (e) {
    t.log('ERROR', e.stack || e);
    t.check('the scenario ran to its end', false);
  }
  await t.finish();
})();
