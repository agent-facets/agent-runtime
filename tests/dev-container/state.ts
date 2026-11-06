// Fixture state for the development container smoke suite (scripts/dev-container-smoke.ts). It runs inside the
// development runtime container, from the source tree mounted there, on that fixture's own database:
//
//   seed              one working run and one run waiting on a question, recorded under the current owner epoch
//                     as the runtime's own records would be — raw records, so nothing is dispatched
//   inspect <ids...>  the current owner epoch and each run's state
//
// Nothing here contacts a provider.
import { SQL } from 'bun';
import { currentEpoch, pauseOnQuestion, seedWorkingRun } from '../support/run-records.ts';

const url = process.env.DATABASE_URL;
if (url === undefined || url === '') throw new Error('DATABASE_URL is not set');
const sql = new SQL(url);

try {
  const [mode, ...ids] = process.argv.slice(2);
  if (mode === 'seed') {
    const seeded = await sql.begin(async (tx) => {
      const working = await seedWorkingRun(tx);
      const waiting = await pauseOnQuestion(tx, await seedWorkingRun(tx));
      return { working: working.runId, waiting: waiting.runId };
    });
    console.log(JSON.stringify(seeded));
  } else if (mode === 'inspect') {
    const rows = await sql`select run_id::text as run_id, state->>'kind' as kind from runtime.runs
      where run_id = any(${sql.array(ids, 'uuid')})`;
    const states = Object.fromEntries(rows.map((row: { run_id: string; kind: string }) => [row.run_id, row.kind]));
    console.log(JSON.stringify({ epoch: await currentEpoch(sql), states }));
  } else {
    throw new Error('usage: state.ts seed | inspect <run ids...>');
  }
} finally {
  await sql.close();
}
