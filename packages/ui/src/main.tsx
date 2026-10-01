import { createRoot } from 'react-dom/client';
import { ApiClient } from './api/client.ts';
import { App } from './app/App.tsx';

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<App client={new ApiClient()} />);
