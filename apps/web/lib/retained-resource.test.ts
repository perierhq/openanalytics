import { describe, expect, it } from "vitest"

import { retainedView } from "./retained-resource"

const loading = { status: "loading" } as const
const ready = (data: string) => ({ status: "ready", data }) as const

describe("keeping the current figures up while a compared read loads", () => {
  it("shows the last answer for the same figures while their next read is in flight", () => {
    // Toggling Compare re-reads the same range with the previous period
    // beside it: the current numbers are already known and stay up.
    expect(retainedView(loading, "site|today", { key: "site|today", data: "12,874" })).toEqual({
      resource: ready("12,874"),
      refreshing: true,
    })
  })

  it("does not carry figures across to a different range or filter", () => {
    expect(retainedView(loading, "site|7d", { key: "site|today", data: "12,874" })).toEqual({
      resource: loading,
      refreshing: false,
    })
  })

  it("loads as usual when nothing has answered yet", () => {
    expect(retainedView(loading, "site|today", null)).toEqual({
      resource: loading,
      refreshing: false,
    })
  })

  it("passes a fresh answer or an error straight through", () => {
    const last = { key: "site|today", data: "old" }
    expect(retainedView(ready("new"), "site|today", last)).toEqual({
      resource: ready("new"),
      refreshing: false,
    })
    const error = { status: "error", error: { title: "x" }, retry: () => {} } as never
    expect(retainedView(error, "site|today", last).resource).toBe(error)
  })
})
