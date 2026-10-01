// One headless Chromium for all browser suites in a run. Closing one Playwright browser and launching another in
// the same Bun process was observed to break the second one's connection, so suites share a browser and close only
// their own contexts; the browser ends with the test process.
import { type Browser, chromium } from 'playwright';

let shared: Promise<Browser> | undefined;

export function sharedBrowser(): Promise<Browser> {
  shared ??= chromium.launch();
  return shared;
}
