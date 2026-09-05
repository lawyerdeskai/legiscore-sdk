// The package root is `"type": "module"`, so every .js file under it is ESM unless a nested
// package.json says otherwise. The CommonJS output needs that marker to load at all.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

for (const directory of process.argv.slice(2)) {
  writeFileSync(join(directory, "package.json"), '{\n  "type": "commonjs"\n}\n');
}
