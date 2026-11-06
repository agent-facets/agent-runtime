// The production entry point. The environment is checked before any framework or provider module loads (see
// launch.ts); the runtime itself is imported only afterwards.
import { launch } from './launch.ts';

await launch();
