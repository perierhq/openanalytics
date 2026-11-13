import { describe, expect, it } from "vitest"

import {
  editableStep,
  parseWhere,
  stepLabel,
  storedStep,
} from "./funnel-steps"

/**
 * The editor's step forms against the contract's string (the domain's
 * `parseFunnelStep` is the reference for what a stored step means).
 */
describe("funnel steps in the editor", () => {
  it("keeps the plain form for a path without * and an event without conditions", () => {
    expect(storedStep({ kind: "page", value: "/pricing", where: "" })).toBe("/pricing")
    expect(storedStep({ kind: "page", value: "pricing", where: "" })).toBe("/pricing")
    expect(storedStep({ kind: "event", value: "signup", where: "" })).toBe("signup")
    expect(storedStep({ kind: "event", value: " ", where: "a=b" })).toBe("")
  })

  it("writes a step object for a wildcard page and an event with conditions", () => {
    expect(storedStep({ kind: "page", value: "/discount/*", where: "" })).toBe(
      '{"page":"/discount/*"}'
    )
    expect(
      storedStep({ kind: "event", value: "plan_selected", where: "plan=yearly, src = paywall" })
    ).toBe('{"event":"plan_selected","where":{"plan":"yearly","src":"paywall"}}')
  })

  it("reads every stored form back into the same fields", () => {
    for (const raw of [
      "/pricing",
      "signup",
      '{"page":"/discount/*"}',
      '{"event":"plan_selected","where":{"plan":"yearly"}}',
    ]) {
      expect(storedStep(editableStep(raw))).toBe(raw)
    }
  })

  it("refuses a condition without = and more than three", () => {
    expect(parseWhere("plan").ok).toBe(false)
    expect(parseWhere("=x").ok).toBe(false)
    expect(parseWhere("a=1,b=2,c=3,d=4").ok).toBe(false)
    expect(parseWhere("")).toEqual({ ok: true, where: {} })
  })

  it("labels a step the way a person reads it", () => {
    expect(stepLabel("/pricing")).toBe("/pricing")
    expect(stepLabel('{"page":"/discount/*"}')).toBe("/discount/*")
    expect(stepLabel('{"event":"plan_selected","where":{"plan":"yearly"}}')).toBe(
      "plan_selected · plan=yearly"
    )
  })
})
