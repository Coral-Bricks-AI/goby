// Entry point for the `progress.js` bundle; the logic and its rationale are in progress.ts.
import { main } from './progress.ts';

main(process.argv.slice(2), process.env).finally(() => { process.exitCode = 0; });
