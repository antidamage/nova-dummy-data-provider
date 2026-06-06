import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
await mkdir(path.join(root, "public"), { recursive: true });
await copyFile(path.join(root, "src", "provider", "provider.mjs"), path.join(root, "public", "provider.mjs"));
await mkdir(path.join(root, "public", "api"), { recursive: true });
for (const fileName of await readdir(path.join(root, "src", "fixtures"))) {
  await copyFile(path.join(root, "src", "fixtures", fileName), path.join(root, "public", "api", fileName));
}
await writeFile(path.join(root, "public", ".nojekyll"), "");
console.log("Built public/provider.mjs and public/api fixtures");
