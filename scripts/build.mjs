import { copyFile, cp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
await mkdir(path.join(root, "public"), { recursive: true });
for (const fileName of (await readdir(path.join(root, "src", "provider"))).filter((name) => name.endsWith(".mjs"))) {
  await copyFile(path.join(root, "src", "provider", fileName), path.join(root, "public", fileName));
}
await mkdir(path.join(root, "public", "api"), { recursive: true });
for (const fileName of await readdir(path.join(root, "src", "fixtures"))) {
  await copyFile(path.join(root, "src", "fixtures", fileName), path.join(root, "public", "api", fileName));
}
await writeFile(path.join(root, "public", ".nojekyll"), "");
await cp(path.join(root, "src", "assets"), path.join(root, "public", "assets"), { recursive: true });
console.log("Built public/provider.mjs and public/api fixtures");
