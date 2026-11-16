import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * What the public share board pulls into its bundle, read off the source: the
 * board is open to anyone with the link, so code for an owner's revenue has
 * no business shipping with it.
 */
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? resolve(WEB, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null
  if (base === null) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Every app module reachable from `entry` through value imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, "utf8")
    // `import type` and `export type` vanish at build time; everything else ships.
    const pattern = /(?:^|\n)\s*(import|export)(\s+type)?\s[^;]*?from\s+"([^"]+)"/g
    for (const match of source.matchAll(pattern)) {
      if (match[2] !== undefined) continue
      const target = resolveImport(file, match[3])
      if (target !== null) queue.push(target)
    }
  }
  return new Set([...seen].map((file) => file.slice(WEB.length + 1)))
}

describe("the public share board's bundle", () => {
  const modules = reachable(resolve(WEB, "components/share/share-board.tsx"))

  it("is read off the real import graph", () => {
    expect(modules.has("components/dashboard/hover-list.tsx")).toBe(true)
    expect(modules.has("lib/source-rows.ts")).toBe(true)
  })

  it("carries no row revenue code", () => {
    expect(modules.has("components/dashboard/row-revenue.tsx")).toBe(false)
    expect(modules.has("lib/row-revenue.ts")).toBe(false)
    expect(modules.has("components/dashboard/top-sources-card.tsx")).toBe(false)
  })
})
