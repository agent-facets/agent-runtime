// One headless Chromium for all browser suites in a run. Closing one Playwright browser and launching another in
// the same Bun process was observed to break the second one's connection, so suites share a browser and close only
// their own contexts; the browser ends with the test process.
import type { Browser } from 'playwright';

export type LaunchBrowser = () => Promise<Browser>;

/** Returns a getter that launches once and hands every caller the same browser, or the same launch failure. */
export function browserLauncher(launch: LaunchBrowser): () => Promise<Browser> {
  let shared: Promise<Browser> | undefined;
  return () => {
    shared ??= launch().catch((error: unknown) => {
      throw explainLaunchFailure(error);
    });
    return shared;
  };
}

/** Points a missing pinned browser at its install command; any other launch failure is returned unchanged. */
export function explainLaunchFailure(error: unknown): unknown {
  if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
    return new Error('the pinned headless browser is not installed: run `bun run browser:install` first.', {
      cause: error,
    });
  }
  return error;
}

export const sharedBrowser = browserLauncher(async () => (await import('playwright')).chromium.launch());
