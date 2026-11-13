// Entry point for the `wake.js` bundle; the logic and its rationale are in wake/main.ts.
import { main } from './wake/main.ts';

main(process.argv.slice(2), process.env).then(
  code => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`wake: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
