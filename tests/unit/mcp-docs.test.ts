import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MCP_TOOLS, isReadOnlyTool } from '../../apps/api/src/http/mcp.ts'

/**
 * SELF-HOSTING.md's MCP section lists the read tools by name. A table that
 * lists what the code serves goes stale the first time a tool is added, so
 * this pins the two together: every read tool is named there, and every name
 * there is a tool.
 */
const DOC = fileURLToPath(new URL('../../SELF-HOSTING.md', import.meta.url))

async function mcpSection(): Promise<string> {
  const text = await readFile(DOC, 'utf8')
  const start = text.indexOf('\n### MCP\n')
  expect(start, 'SELF-HOSTING.md has an MCP section').toBeGreaterThan(-1)
  const rest = text.slice(start + 1)
  const end = rest.indexOf('\n### ', 1)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the MCP tool table in SELF-HOSTING.md', () => {
  it('names every read tool the server lists', async () => {
    const section = await mcpSection()
    for (const tool of MCP_TOOLS.filter(isReadOnlyTool)) {
      expect(section, `${tool.name} is missing from SELF-HOSTING.md`).toContain(`\`${tool.name}\``)
    }
  })

  it('names no tool the server does not list', async () => {
    const section = await mcpSection()
    const table = section.split('\n').filter((line) => line.startsWith('| `'))
    const named = table.flatMap((line) =>
      [...(line.split('|')[1] ?? '').matchAll(/`([a-z_]+)`/gu)].map((match) => match[1]),
    )
    const served = new Set(MCP_TOOLS.map((tool) => tool.name))
    for (const name of named) expect(served.has(name as string), `${name} is not a tool`).toBe(true)
  })
})
