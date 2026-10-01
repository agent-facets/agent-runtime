import type { ApiClient } from '../api/client.ts';
import { Home } from './Home.tsx';
import { RunDetail } from './RunDetail.tsx';
import { useRoute } from './route.ts';

export function App({ client }: { client: ApiClient }) {
  const route = useRoute();
  return (
    <>
      <header className="masthead">
        <a href="#/">Agent runtime</a>
      </header>
      {route.view === 'run' ? (
        <RunDetail key={route.runId} client={client} runId={route.runId} />
      ) : (
        <Home client={client} />
      )}
    </>
  );
}
