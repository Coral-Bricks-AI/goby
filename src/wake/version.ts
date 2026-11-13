/**
 * goby's version, for the record this tool prints.
 *
 * The file is copied beside the bundle in the image (`/opt/wake/VERSION`), because a compiled
 * Node program cannot see the repository it was built from. Absent, the version is null and the
 * record says so: a record under a release tag it cannot name is a data point under the wrong tag,
 * and a null is unambiguous where a guessed `0.0.0` is not.
 */
import { readFileSync } from 'node:fs';

export function gobyVersion(): string | null {
  const path = process.env.GOBY_VERSION_FILE ?? new URL('./VERSION', import.meta.url);
  try {
    const found = readFileSync(path, 'utf8').trim();
    return /^[0-9][0-9A-Za-z.+-]*$/.test(found) ? found : null;
  } catch {
    return null;
  }
}
