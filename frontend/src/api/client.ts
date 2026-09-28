import createClient from "openapi-fetch";

import type { paths } from "./schema";

// Same-origin by default: the Vite dev proxy (dev) or nginx (prod) fronts
// the API. No CORS anywhere (DESIGN.md §7).
export const api = createClient<paths>();
