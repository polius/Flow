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
const build = createHash("sha256").update(assets.join("\n")).digest("hex").slice(0, 12);

const file = new URL("sw.js", dist);
const stamped = readFileSync(file, "utf8")
  .replace('"__FLOW_BUILD__"', JSON.stringify(build))
  .replace('["__FLOW_PRECACHE__"]', JSON.stringify(assets));
if (stamped.includes("__FLOW_")) throw new Error("sw.js: build placeholders not found");
writeFileSync(file, stamped);
console.log(`sw.js stamped: build ${build}, ${assets.length} files`);
