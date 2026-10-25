import { describe, expect, test } from 'bun:test';
import type { Browser } from 'playwright';
import { browserLauncher, explainLaunchFailure } from '../tests/support/browser.ts';

const fakeBrowser = () => ({}) as Browser;

describe('shared browser', () => {
  test('concurrent and later callers share one launch and one browser', async () => {
    let launches = 0;
    let finish: (browser: Browser) => void = () => {};
    const browser = fakeBrowser();
    const get = browserLauncher(() => {
      launches += 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });

    const first = get();
    const second = get();
    expect(launches).toBe(1);
    finish(browser);
    expect(await first).toBe(browser);
    expect(await second).toBe(browser);
    expect(await get()).toBe(browser);
    expect(launches).toBe(1);
  });

  test('a failed launch is reported to every caller and never retried', async () => {
    let launches = 0;
    const failure = new Error('launch failed');
    const get = browserLauncher(async () => {
      launches += 1;
      throw failure;
    });

    const callers = [get(), get()];
    for (const caller of callers) await expect(caller).rejects.toBe(failure);
    await expect(get()).rejects.toBe(failure);
    expect(launches).toBe(1);
  });

  test('a missing browser points at the install command and keeps the original error', () => {
    const missing = new Error("browserType.launch: Executable doesn't exist at /cache/chromium/headless_shell");
    const explained = explainLaunchFailure(missing);
    expect(explained).toBeInstanceOf(Error);
    expect((explained as Error).message).toContain('bun run browser:install');
    expect((explained as Error).cause).toBe(missing);
  });

  test('other launch failures are not reported as a missing browser', () => {
    const crashed = new Error('browserType.launch: Target page, context or browser has been closed');
    expect(explainLaunchFailure(crashed)).toBe(crashed);
    expect(explainLaunchFailure('not an error')).toBe('not an error');
  });
});
