// Explicit integration launcher. Provisions a uniquely named, disposable PostgreSQL fixture on loopback,
// runs the integration suites against it with an allowlisted environment, and removes only what it created.
import { assertSafeLaunch } from './lib/fixture-env.ts';
import { runSuiteWithFixture } from './lib/postgres-fixture.ts';

assertSafeLaunch('test:integration', process.argv.slice(2), process.env);
process.exit(await runSuiteWithFixture('./tests/integration', 'it'));
