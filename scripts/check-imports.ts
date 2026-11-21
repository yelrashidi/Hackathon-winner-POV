import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Load production modules through the same tsx runner used by our CLI scripts.
// This catches runtime exports, dependencies and aliases that typechecking alone misses.
async function sourceModules(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...await sourceModules(file));
    } else if (entry.name.endsWith(".ts") && !/\.(?:test|spec|d)\.ts$/.test(entry.name)) {
      files.push(file);
    }
  }
  return files.sort();
}

const files = await sourceModules(path.resolve("src"));
if (files.length === 0) throw new Error("No source modules found to check");
for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (cause) {
    throw new Error(`Import failed: ${path.relative(process.cwd(), file)}`, { cause });
  }
}
console.log(`Successfully imported ${files.length} source modules`);
