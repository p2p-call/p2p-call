// A call with no program behind it: created on the site's page, the pages
// find each other on the board and talk directly.
//
// With SPARE=wss://… the first board is out of reach and everything goes
// over that spare board alone (a real public MQTT server: needs the internet,
// costs nothing of the first board's allowance).
const t = require('./lib.cjs');
const opts = process.env.SPARE ? { board: 'http://localhost:1', spare: process.env.SPARE } : {};

(async () => {
  try {
    if (!process.env.SPARE) await t.startBoard();
    await t.startSite();

    const host = await t.page('host', t.SITE + '#create', opts);
    await t.enter(host, 'Mike');
    const tail = (await host.evaluate(() => state.invite)).split('#')[1];
    t.check('a one-time link: name~secret~until', /^[\w-]{22}~[\w-]{22}~[a-z0-9]+$/.test(tail));
    const link = t.SITE + '#' + tail;

    const a = await t.page('a', link, opts);
    await t.enter(a, 'Pete');
    const b = await t.page('b', link, opts);
    await t.enter(b, 'Vic');
    t.check('everyone is connected to everyone', await t.meshed([host, a, b], 60000));
    t.check('everyone hears everyone', await t.hears([host, a, b]));

    // A word in the chat reaches the others directly.
    await a.evaluate(() => { $('chatText').value = 'hello from the script'; chatSay(); });
    await t.sleep(1500);
    t.check('the chat reaches everyone', (await Promise.all([host, b].map((p) => p.evaluate(() => state.chat.some((m) => m.text === 'hello from the script'))))).every(Boolean));

    // The chat stays out of the way: a button with a count, a window over the call.
    t.check('the button counts what came in', (await host.textContent('#chatNew')) === '1' && await host.isHidden('#chatPanel'));
    await host.click('#moreBtn');
    await host.click('#chatBtn');
    t.check('the chat opens over the call', await host.isVisible('#chatList') && await host.isHidden('#chatNew'));
    if (process.env.SHOTS) {
      await host.setViewportSize({ width: 390, height: 780 });
      for (let i = 0; i < 14; i++) {
        await (i % 3 ? a : host).evaluate((n) => { $('chatText').value = ['can you hear me?', 'yes, all good', 'here is a link https://example.org/song', 'turning on music now'][n % 4] + ' ' + n; chatSay(); }, i);
        await t.sleep(120);
      }
      await t.sleep(800);
      await host.screenshot({ path: process.env.SHOTS + '/chat-open.png' });
      await host.click('#chatClose');
      await a.evaluate(() => { $('chatText').value = 'this came while it was closed'; chatSay(); });
      await t.sleep(600);
      await host.screenshot({ path: process.env.SHOTS + '/chat-closed.png' });
    } else {
      await host.click('#chatClose');
    }
    t.check('and closes', await host.isHidden('#chatPanel'));

    // The organizer's orders: remove one, then end the call for all.
    const bId = await b.evaluate(() => state.me.id);
    await host.evaluate((id) => send({ type: 'kick', id }), bId);
    await b.waitForSelector('#endScreen:not([hidden])', { timeout: 10000 });
    await t.sleep(1000);
    t.check('a removed guest is out', (await a.evaluate(() => state.peers.size)) === 1);

    const said = await Promise.all([host, a].map((p) => p.evaluate(() => mt.said)));
    t.log('  messages on the board: host', said[0], 'a', said[1]);

    await host.evaluate(() => send({ type: 'end' }));
    await a.waitForSelector('#endScreen:not([hidden])', { timeout: 10000 });
    t.check('the call is ended for everyone', true);
    await t.sleep(1500);

    // The one-time link is dead from now on: the boards remember the order.
    const late = await t.page('late', link, opts);
    await late.waitForSelector('#name');
    await late.fill('#name', 'Late');
    await late.click('#enter');
    await late.waitForSelector('#joinBtn');
    await late.click('#joinBtn');
    await late.waitForSelector('#endScreen:not([hidden])', { timeout: 20000 });
    t.check('the link lets nobody in afterwards', (await late.textContent('#endText')).includes('ended'));
  } catch (e) {
    t.log('ERROR', e.stack || e);
    t.check('the scenario ran to its end', false);
  }
  await t.finish();
})();
