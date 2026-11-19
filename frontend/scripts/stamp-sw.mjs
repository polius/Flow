/* After `vite build`: stamp dist/sw.js with this build. Its cache name is
   a hash of the build's file names (a new build is a new cache, the same
   build the same one), and its install list is every script and
   stylesheet the build has. Fails when sw.js lost its placeholders, so the
   stamp cannot be forgotten. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
const assets = readdirSync(new URL("assets/", dist))
  .filter((f) => /\.(js|css)$/.test(f))
  .sort()
  .map((f) => `/assets/${f}`);
// The page itself is part of the build: a change to index.html alone is a
// new build too.
const build = createHash("sha256")
  .update(assets.join("\n"))
  .update(readFileSync(new URL("index.html", dist)))
  .digest("hex")
  .slice(0, 12);

const file = new URL("sw.js", dist);
const source = readFileSync(file, "utf8");
const placeholders = ['const BUILD = "__FLOW_BUILD__";', 'const PRECACHE = ["__FLOW_PRECACHE__"];'];
for (const p of placeholders) {
  if (!source.includes(p)) throw new Error(`sw.js: placeholder missing: ${p}`);
}
if (assets.length === 0) throw new Error("sw.js: the build has no assets to store");
const stamped = source
  .replace(placeholders[0], `const BUILD = ${JSON.stringify(build)};`)
  .replace(placeholders[1], `const PRECACHE = ${JSON.stringify(assets)};`);
writeFileSync(file, stamped);
console.log(`sw.js stamped: build ${build}, ${assets.length} files`);
