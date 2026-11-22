import { describe, expect, it, vi } from "vitest"

import type { ChartNote, Mention, RevenueConnectionState, RevenueTransaction } from "./api"
import {
  canReadRevenue,
  isSale,
  loadChartMarkers,
  loadChartNotes,
  parseHiddenLayers,
  saleAmount,
  sharedRevenueState,
  saleTotals,
  type ChartMarkerDeps,
} from "./chart-markers"
import { loadChartRevenue } from "./chart-revenue"

const RANGE = {
  from: "2026-06-20T00:00:00.000Z",
  to: "2026-07-20T00:00:00.000Z",
  timezone: "UTC",
}

const money = (amount_minor: number, currency = "EUR") => ({ amount_minor, currency })

const tx = (overrides: Partial<RevenueTransaction> = {}): RevenueTransaction =>
  ({
    object_id: "ch_1",
    provider: "stripe",
    object_kind: "charge",
    occurred_at: "2026-07-01T10:00:00.000Z",
    status: "succeeded",
    livemode: true,
    gross: money(5000),
    refund: money(0),
    fee: money(175),
    net: money(4825),
    reporting: money(5200, "USD"),
    conversion: null,
    parent_object_id: null,
    order_id: null,
    product_name: "Pro",
    matched_via: "none",
    confidence: "none",
    purchase_kind: "new",
    ...overrides,
  }) as RevenueTransaction

function deps(
  state: RevenueConnectionState | Error = { status: "not_connected" },
  options: { mentions?: Mention[] | Error; transactions?: RevenueTransaction[] | Error } = {}
) {
  const listMentions = vi.fn(async () => {
    if (options.mentions instanceof Error) throw options.mentions
    return { items: options.mentions ?? [], next_cursor: null, has_more: false }
  })
  const revenueState = vi.fn(async () => {
    if (state instanceof Error) throw state
    return state
  })
  const revenueTransactions = vi.fn(async () => {
    if (options.transactions instanceof Error) throw options.transactions
    return { items: options.transactions ?? [], next_cursor: null, has_more: false }
  })
  return {
    listMentions,
    revenueState,
    revenueTransactions,
  } satisfies ChartMarkerDeps
}

const ACTIVE = { status: "active" } as RevenueConnectionState

describe("who gets sale markers", () => {
  it("only the owner may read revenue", () => {
    expect(canReadRevenue("owner")).toBe(true)
    expect(canReadRevenue("admin")).toBe(false)
    expect(canReadRevenue("viewer")).toBe(false)
  })

  it("never asks the revenue api for an admin or a viewer", async () => {
    for (const role of ["admin", "viewer"] as const) {
      const d = deps(ACTIVE, { transactions: [tx()] })
      const result = await loadChartMarkers({ siteId: "s", role, range: RANGE }, d)
      expect(d.revenueState).not.toHaveBeenCalled()
      expect(d.revenueTransactions).not.toHaveBeenCalled()
      expect(d.listMentions).toHaveBeenCalledOnce()
      expect(result.sales).toEqual([])
    }
  })

  it("asks for transactions only once a connection exists, one page of 200", async () => {
    const off = deps({ status: "not_connected" })
    await loadChartMarkers({ siteId: "s", role: "owner", range: RANGE }, off)
    expect(off.revenueState).toHaveBeenCalledOnce()
    expect(off.revenueTransactions).not.toHaveBeenCalled()

    const on = deps(ACTIVE, { transactions: [tx()] })
    const result = await loadChartMarkers({ siteId: "s", role: "owner", range: RANGE }, on)
    expect(on.revenueTransactions).toHaveBeenCalledWith(
      "s",
      RANGE,
      expect.objectContaining({ limit: 200 })
    )
    expect(result.sales).toHaveLength(1)
  })

  it("turns a failed revenue read into no sale markers, and keeps the mentions", async () => {
    const forbidden = deps(new Error("403"), { mentions: [{ id: "m" } as Mention] })
    const a = await loadChartMarkers({ siteId: "s", role: "owner", range: RANGE }, forbidden)
    expect(a.sales).toEqual([])
    expect(a.mentions).toHaveLength(1)

    const failed = deps(ACTIVE, { transactions: new Error("500"), mentions: new Error("404") })
    const b = await loadChartMarkers({ siteId: "s", role: "owner", range: RANGE }, failed)
    expect(b).toEqual({ mentions: [], sales: [] })
  })

  it("asks for mentions in the chart range with a limit of 200", async () => {
    const d = deps()
    await loadChartMarkers({ siteId: "s", role: "viewer", range: RANGE }, d)
    expect(d.listMentions).toHaveBeenCalledWith(
      "s",
      RANGE,
      expect.objectContaining({ limit: 200 })
    )
  })
})

describe("what counts as a sale", () => {
  it("is a live charge that went through, refunded later or not", () => {
    expect(isSale(tx())).toBe(true)
    expect(isSale(tx({ status: "partially_refunded" }))).toBe(true)
    expect(isSale(tx({ status: "refunded" }))).toBe(true)
    expect(isSale(tx({ status: "failed" }))).toBe(false)
    expect(isSale(tx({ status: "pending" }))).toBe(false)
    expect(isSale(tx({ object_kind: "refund" }))).toBe(false)
    expect(isSale(tx({ object_kind: "dispute" }))).toBe(false)
    expect(isSale(tx({ livemode: false }))).toBe(false)
  })

  it("is worth its reporting amount, or its own net when no rate existed", () => {
    expect(saleAmount(tx())).toEqual(money(5200, "USD"))
    expect(saleAmount(tx({ reporting: null, conversion: null }))).toEqual(money(4825))
  })

  it("adds up per currency, so unconverted sales are never summed into the reporting total", () => {
    expect(
      saleTotals([
        tx(),
        tx({ reporting: money(800, "USD") }),
        tx({ reporting: null, net: money(1000, "GBP") }),
      ])
    ).toEqual([money(6000, "USD"), money(1000, "GBP")])
  })
})

describe("one connection read per site", () => {
  it("serves the marker and revenue loaders from one revenue.state read", async () => {
    const read = vi.fn(async () => ACTIVE)
    const revenueState = sharedRevenueState(read)
    const d = deps(ACTIVE, { transactions: [tx()] })
    await Promise.all([
      loadChartMarkers({ siteId: "s", role: "owner", range: RANGE }, { ...d, revenueState }),
      loadChartRevenue(
        { siteId: "s", role: "owner", range: RANGE, grain: "day" },
        { revenueState, revenueTimeseries: async () => ({ series: [] }) }
      ),
    ])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith("s", {})
  })

  it("reads each site on its own", async () => {
    const read = vi.fn(async () => ACTIVE)
    const revenueState = sharedRevenueState(read)
    await revenueState("a", {})
    await revenueState("b", {})
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("does not keep a failed read", async () => {
    const read = vi
      .fn<() => Promise<RevenueConnectionState>>()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue(ACTIVE)
    const revenueState = sharedRevenueState(read)
    await expect(revenueState("s", {})).rejects.toThrow("503")
    await expect(revenueState("s", {})).resolves.toEqual(ACTIVE)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("reads again once the answer is a minute old, so a new connection shows up", async () => {
    let now = 0
    const read = vi.fn(async () => ACTIVE)
    const revenueState = sharedRevenueState(read, { ttlMs: 60_000, now: () => now })
    await revenueState("s", {})
    now = 59_999
    await revenueState("s", {})
    expect(read).toHaveBeenCalledTimes(1)
    now = 60_000
    await revenueState("s", {})
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe("the remembered legend choice", () => {
  it("reads a choice saved before the revenue layer existed", () => {
    expect(parseHiddenLayers('["sale"]')).toEqual(["sale"])
  })

  it("reads a choice saved before notes existed, and remembers notes hidden", () => {
    expect(parseHiddenLayers('["sale","mention","revenue"]')).toEqual([
      "sale",
      "mention",
      "revenue",
    ])
    expect(parseHiddenLayers('["note","revenue"]')).toEqual(["note", "revenue"])
  })

  it("keeps the layers it knows and drops the rest", () => {
    expect(parseHiddenLayers('["revenue","x"]')).toEqual(["revenue"])
  })

  it("treats a broken value as nothing hidden", () => {
    expect(parseHiddenLayers("{not json")).toEqual([])
    expect(parseHiddenLayers('{"sale":true}')).toEqual([])
  })
})

describe("the notes on the chart", () => {
  const note = { id: "n1", at: "2026-07-01T10:00:00.000Z", text: "Launch" } as ChartNote

  it("are read in the chart range, with no role to gate on: every member reads", async () => {
    const listNotes = vi.fn(async () => ({ items: [note] }))
    const notes = await loadChartNotes({ siteId: "s", range: RANGE }, { listNotes })
    expect(listNotes).toHaveBeenCalledWith("s", RANGE, expect.objectContaining({}))
    expect(notes).toEqual([note])
  })

  it("turn a failed read into no notes, never a broken chart", async () => {
    const listNotes = vi.fn(async () => {
      throw new Error("500")
    })
    expect(await loadChartNotes({ siteId: "s", range: RANGE }, { listNotes })).toEqual(
      []
    )
  })
})
