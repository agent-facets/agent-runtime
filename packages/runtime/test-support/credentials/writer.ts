// Child process for credential crash tests: replaces a record and, at the requested write boundary, reports the
// boundary on stdout and waits to be killed. Synthetic credentials only.
import { CredentialStore, type WritePoint } from '../../src/credentials/store.ts';

const [root, recordJson, point] = process.argv.slice(2);
if (root === undefined || recordJson === undefined || point === undefined)
  throw new Error('usage: writer <root> <record> <point>');

const store = new CredentialStore(root);
await store.replace(JSON.parse(recordJson), {
  maxWriteBytes: 16,
  at: async (reached: WritePoint) => {
    if (reached !== point) return;
    process.stdout.write(`at:${reached}\n`);
    await new Promise(() => {});
  },
});
process.stdout.write('done\n');
