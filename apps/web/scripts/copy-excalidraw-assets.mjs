// Copies Excalidraw's fonts into public/excalidraw so the app serves them
// itself: the COEP require-corp headers (see next.config.ts) would block the
// default CDN fetch. Runs before dev and build; public/excalidraw is
// generated output and gitignored. The component sets
// window.EXCALIDRAW_ASSET_PATH = "/excalidraw/" to point here.
import { cpSync, existsSync, mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
// The package's exports map hides package.json; resolve the entry point
// (dist/prod/index.js) and take its directory.
const distDir = dirname(require.resolve("@excalidraw/excalidraw"))
const outDir = join(import.meta.dirname, "..", "public", "excalidraw")

mkdirSync(outDir, { recursive: true })
const fonts = join(distDir, "fonts")
if (existsSync(fonts)) {
  cpSync(fonts, join(outDir, "fonts"), { recursive: true })
}
console.log(`excalidraw assets → ${outDir}`)
