// The program's start page: one button to begin, the way of beginning and the
// tunnel remembered, somebody else's call by its link, the settings.
// (No call leaves this computer: the program runs with -tunnel self.)
const t = require('./lib.cjs');

(async () => {
  try {
    const url = await new Promise((done, fail) => {
      const lines = [];
      t.run(process.env.P2P_BIN, ['-tunnel', 'self', '-relay', 'none', '-port', '8765'], (l) => {
        lines.push(l);
        const m = /http:\/\/127\.0\.0\.1:\d+\/\?t=\w+/.exec(l);
        if (m) done(m[0]);
      });
      setTimeout(() => fail(new Error('the program did not start:\n' + lines.join('\n'))), 15000);
    });
    const p = await t.page('start', url);
    await p.setViewportSize({ width: 390, height: 780 });
    await p.waitForFunction(() => /link/i.test(document.querySelector('#howText').textContent));
    t.check('one button to begin, and under it how', await p.isVisible('#create') && /Permanent link/.test(await p.textContent('#howText')));
    if (process.env.OUT) await p.screenshot({ path: process.env.OUT + '/s1-main.png' });

    await p.click('#howBtn');
    if (process.env.OUT) await p.screenshot({ path: process.env.OUT + '/s2-how.png' });
    await p.check('input[name=mode][value=bare]');
    t.check('with no tunnel there is no tunnel to choose', await p.isHidden('#tunnelLine'));
    await p.check('input[name=mode][value=direct]');
    t.check('with one there is', await p.isVisible('#tunnelLine'));
    await p.click('#howBox [data-shut]');
    t.check('the choice shows under the button', /Direct link/.test(await p.textContent('#howText')));

    await p.click('#other');
    if (process.env.OUT) await p.screenshot({ path: process.env.OUT + '/s3-other.png' });
    await p.fill('#link', 'hello');
    await p.click('#enter');
    t.check('what is no link is not taken for one', /look like a call link/.test(await p.textContent('#otherNote')));
    await p.click('#otherBox [data-shut]');
    await p.click('#setBtn');
    if (process.env.OUT) await p.screenshot({ path: process.env.OUT + '/s4-settings.png' });
    await p.click('#setBox [data-shut]');

    await p.reload();
    await p.waitForFunction(() => /Direct/.test(document.querySelector('#howText').textContent));
    t.check('the choice is remembered', true);

    await p.click('#create');
    await p.waitForSelector('#joinBtn', { timeout: 15000 });
    await t.enter(p, 'Mike');
    t.check('"Start call" begins a call of the kind chosen', await p.isVisible('#directNote'));
  } catch (e) {
    t.log('ERROR', e.stack || e);
    t.check('the scenario ran to its end', false);
  }
  await t.finish();
})();
