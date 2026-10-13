import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPinnedCli, PINNED_CLI, platformKey, ToolchainError, verifyPinnedCli } from './toolchain.ts';

const sha = 'c7b781b1a7cac5ce459cccb41da4ad12d0e6545d5cc6381a18a90706feb8451a';
const scratch = mkdtempSync(join(tmpdir(), 'facet-toolchain-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('pinned facet CLI', () => {
  test('accepts exactly the approved version and Linux x86-64 binary', () => {
    expect(PINNED_CLI.version).toBe('0.36.0');
    expect(() => checkPinnedCli({ version: '0.36.0', platform: 'linux-x64', sha256: sha })).not.toThrow();
  });

  test('refuses another version, binary or unpinned platform', () => {
    for (const identity of [
      { version: '0.33.0', platform: 'linux-x64', sha256: sha },
      { version: '0.36.0', platform: 'linux-x64', sha256: '0'.repeat(64) },
      { version: '0.36.0', platform: 'darwin-arm64', sha256: sha },
    ]) {
      expect(() => checkPinnedCli(identity)).toThrow(ToolchainError);
    }
  });

  test('never executes a binary whose digest is not pinned, and never fetches a missing one', async () => {
    const witness = join(scratch, 'executed');
    const binary = join(scratch, 'facet');
    writeFileSync(binary, `#!/bin/sh\ntouch '${witness}'\necho 0.36.0\n`);
    chmodSync(binary, 0o755);
    await expect(verifyPinnedCli(binary)).rejects.toThrow(ToolchainError);
    expect(existsSync(witness)).toBe(false);
    await expect(verifyPinnedCli(join(scratch, 'absent'))).rejects.toThrow('not found');
  });

  test('runs a pinned binary only to confirm its reported version', async () => {
    const binary = join(scratch, 'facet-old');
    writeFileSync(binary, '#!/bin/sh\necho 0.34.0\n');
    chmodSync(binary, 0o755);
    const digest = new Bun.CryptoHasher('sha256').update(await Bun.file(binary).arrayBuffer()).digest('hex');
    const pins = { version: '0.36.0', sha256: { [platformKey()]: digest } };
    await expect(verifyPinnedCli(binary, pins)).rejects.toThrow('0.34.0');
    expect(await verifyPinnedCli(binary, { ...pins, version: '0.34.0' })).toEqual({
      version: '0.34.0',
      platform: platformKey(),
      sha256: digest,
    });
  });
});
