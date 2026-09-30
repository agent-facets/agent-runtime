import { describe, expect, test } from 'bun:test';
import { createContentPolicy } from '../security/content-policy.ts';
import { CredentialScreen, SCREEN_CAPACITY, ScreenCapacityError, ScreenScope } from './screening.ts';

const generation = (n: number, provider: 'anthropic' | 'openai' = 'anthropic') => ({
  provider,
  slot: 'default',
  generation: n,
  accessToken: `synthetic-access-${provider}-${n}-token`,
  refreshToken: `synthetic-refresh-${provider}-${n}-token`,
});

const screened = (screen: CredentialScreen, value: string) =>
  createContentPolicy(screen.matcher()).detect(`x ${value} y`) === 'known_credential';

describe('credential screen', () => {
  test('a generation is screened as soon as it is leased, and stays screened after release', () => {
    const screen = new CredentialScreen();
    expect(screened(screen, generation(1).accessToken)).toBe(false);
    const lease = screen.lease(generation(1));
    expect(screened(screen, generation(1).accessToken)).toBe(true);
    expect(screened(screen, generation(1).refreshToken)).toBe(true);
    lease.release();
    screen.lease(generation(2)).release();
    for (const value of [generation(1).accessToken, generation(2).accessToken, generation(2).refreshToken]) {
      expect(screened(screen, value)).toBe(true);
    }
  });

  test('a leased generation survives any number of rotations; idle ones make room', () => {
    const screen = new CredentialScreen();
    const inFlight = screen.lease(generation(1));
    // Far more rotations than the screen holds, each leased and released by other requests.
    for (let n = 2; n <= SCREEN_CAPACITY * 4; n++) screen.lease(generation(n)).release();
    expect(screened(screen, generation(1).accessToken)).toBe(true);
    expect(screened(screen, generation(SCREEN_CAPACITY * 4).accessToken)).toBe(true);
    expect(screened(screen, generation(2).accessToken)).toBe(false);
    inFlight.release();
    for (let n = 1_000; n < 1_000 + SCREEN_CAPACITY; n++) screen.lease(generation(n)).release();
    expect(screened(screen, generation(1).accessToken)).toBe(false);
  });

  test('when every retained generation is leased, a new one is refused rather than dropping coverage', () => {
    const screen = new CredentialScreen(3);
    const leases = [1, 2, 3].map((n) => screen.lease(generation(n)));
    expect(() => screen.lease(generation(4))).toThrow(ScreenCapacityError);
    expect(screened(screen, generation(4).accessToken)).toBe(false);
    // Re-leasing an already screened generation needs no room.
    screen.lease(generation(2)).release();
    leases[1]?.release();
    expect(screened(screen, generation(2).accessToken)).toBe(true);
    screen.lease(generation(4));
    for (const n of [1, 3, 4]) expect(screened(screen, generation(n).accessToken)).toBe(true);
    expect(screened(screen, generation(2).accessToken)).toBe(false);
  });

  test('releasing twice ends only one lease', () => {
    const screen = new CredentialScreen(2);
    const first = screen.lease(generation(1));
    screen.lease(generation(1));
    first.release();
    first.release();
    screen.lease(generation(2));
    // Generation 1 still has a lease, so there is no room for a third.
    expect(() => screen.lease(generation(3))).toThrow(ScreenCapacityError);
  });

  test('providers and slots are separate generations', () => {
    const screen = new CredentialScreen(2);
    screen.lease(generation(1));
    screen.lease(generation(1, 'openai'));
    expect(() => screen.lease({ ...generation(1), slot: 'other' })).toThrow(ScreenCapacityError);
  });

  test('the screen exposes only matchers', () => {
    const screen = new CredentialScreen();
    screen.lease(generation(1));
    expect(Object.keys(screen)).toEqual([]);
    expect(JSON.stringify(screen)).not.toContain('synthetic');
    expect(JSON.stringify(screen.matcher())).not.toContain('synthetic');
  });
});

describe('screen scope', () => {
  test('holds every generation pinned during a model call until the call is released', () => {
    const screen = new CredentialScreen(3);
    const scope = new ScreenScope(screen);
    scope.pin(generation(1));
    scope.pin(generation(2));
    screen.lease(generation(3));
    expect(() => screen.lease(generation(4))).toThrow(ScreenCapacityError);
    scope.release();
    scope.release();
    screen.lease(generation(4)).release();
    screen.lease(generation(5));
    expect(screened(screen, generation(3).accessToken)).toBe(true);
  });

  test('a full screen refuses the pin with a safe reason', () => {
    const scope = new ScreenScope(new CredentialScreen(1));
    scope.pin(generation(1));
    const error = (() => {
      try {
        scope.pin(generation(2));
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ScreenCapacityError);
    expect((error as ScreenCapacityError).reason).toBe('credential_screen_full');
  });
});
