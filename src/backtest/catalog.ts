// Imported rather than read from disk so esbuild embeds it in dist/cli.mjs, which runs from npx
// without the lists/ folder.
import catalog from "../../lists/catalog.json" with { type: "json" };
import type { ListRef } from "../engine/config.ts";

/** The public trust lists in lists/catalog.json, as rule sources. */
export const CATALOG_LISTS: ListRef[] = (catalog as { repo: string; path?: string }[]).map((entry) => ({
  repo: entry.repo,
  path: entry.path ?? null,
}));
