// Explicit browser-journey launcher: the console in a real (headless) browser against the runtime's service on a
// disposable PostgreSQL fixture, with scripted provider networks. Requires the pinned Playwright browser, installed
// once with `bun run browser:install`; nothing is downloaded here.
import { chromium } from 'playwright';
import { assertSafeLaunch } from './lib/fixture-env.ts';
import { runSuiteWithFixture } from './lib/postgres-fixture.ts';

assertSafeLaunch('test:browser', process.argv.slice(2), process.env);
try {
  await (await chromium.launch()).close();
} catch {
  console.error('test:browser needs the pinned headless browser: run `bun run browser:install` first.');
  process.exit(1);
}
process.exit(await runSuiteWithFixture('./tests/browser', 'it-browser'));
