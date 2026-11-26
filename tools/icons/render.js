const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:8766/models.html');
  await p.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const names = process.argv.length > 3 ? process.argv.slice(3) : await p.evaluate(() => window.MODELS);
  for (const n of names) {
    try { await p.evaluate(n => window.renderModel(n), n); } catch (e) { console.log('FAIL', n, e.message); continue; }
    await p.locator('canvas').screenshot({ path: `${process.argv[2]}/${n}.png`, omitBackground: true });
  }
  console.log('done', names.length);
  await b.close();
})();
