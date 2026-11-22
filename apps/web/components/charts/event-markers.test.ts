// @vitest-environment happy-dom
import { scaleLinear, scaleTime } from "@visx/scale"
import { act, createElement, Fragment, useState, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChartContextValue, TooltipData } from "./chart-context"
import type { ChartPhase } from "./chart-phase"
import type { ChartSelection } from "./use-chart-interaction"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const motionPreference = vi.hoisted(() => ({ reduced: false }))
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => motionPreference.reduced,
}))

const { ChartProvider } = await import("./chart-context")
const { EventMarkers } = await import("./event-markers")
const { ChartTooltip } = await import("./tooltip/chart-tooltip")
const { scrubDimCut } = await import("./scrub-dim")

const DAY = 86_400_000
const START = Date.parse("2026-07-01T00:00:00.000Z")
const BUCKETS = 10
const WIDTH = 450
const PLOT_HEIGHT = 200
const MARGIN = { top: 20, right: 0, bottom: 20, left: 0 }
const DIM = 0.35

const data = Array.from({ length: BUCKETS }, (_, index) => ({
  date: new Date(START + index * DAY),
  visitors: 10 + index * 5,
}))
const xScale = scaleTime({
  domain: [data[0]!.date, data[BUCKETS - 1]!.date],
  range: [0, WIDTH],
})
const yScale = scaleLinear({ domain: [0, 100], range: [PLOT_HEIGHT, 0] })

/** A sale at noon on every listed day. */
const sales = (days: number[]) =>
  days.map((day) => ({ id: `s${day}`, kind: "sale" as const, at: START + day * DAY + DAY / 2, payload: null }))

const faceCalls = vi.fn()
const kinds = {
  sale: {
    describe: (count: number) => `${count} sale${count === 1 ? "" : "s"}`,
    glyph: createElement("i", { "data-glyph": "" }),
    face: (items: readonly unknown[]) => {
      faceCalls(items)
      return createElement("b", { "data-face": "" })
    },
  },
}

type Setup = {
  /** Column width: 45px draws faces, 10px is a dense chart. */
  columnWidth?: number
  chartPhase?: ChartPhase
  tooltipIndex?: number | null
  selection?: ChartSelection | null
  days?: number[]
}

let root: Root | null = null
let host: HTMLDivElement | null = null
let setHover: (index: number | null) => void = () => {}
const setTooltipData = vi.fn()

function tooltipAt(index: number | null): TooltipData | null {
  if (index === null) return null
  return {
    point: data[index]!,
    index,
    x: xScale(data[index]!.date),
    yPositions: { visitors: yScale(data[index]!.visitors) },
  }
}

const xAccessor = (point: Record<string, unknown>) => point.date as Date
const bucketLabel = (start: Date) => start.toISOString().slice(0, 10)
const renderContent = () => createElement("p", null, "popover")

/**
 * The chart's stable slice is built once per render, as the chart builds it:
 * a moving crosshair changes `tooltipData` and nothing else.
 */
function stableSlice(setup: Setup, container: HTMLDivElement) {
  return {
    data,
    renderData: data,
    xScale,
    yScale,
    yScales: { left: yScale },
    width: WIDTH,
    height: PLOT_HEIGHT + MARGIN.top + MARGIN.bottom,
    innerWidth: WIDTH,
    innerHeight: PLOT_HEIGHT,
    margin: MARGIN,
    columnWidth: setup.columnWidth ?? 45,
    containerRef: { current: container },
    lines: [{ dataKey: "visitors", stroke: "black", strokeWidth: 2 }],
    referenceAreas: [],
    chartPhase: setup.chartPhase ?? "ready",
    chartStatus: "ready",
    yDomainTweenDuration: 0,
    yDomainSkeletonByAxis: {},
    yDomainTargetByAxis: {},
    isLoaded: true,
    animationDuration: 1100,
    xAccessor,
    dateLabels: data.map((point) => point.date.toISOString()),
    setTooltipData,
    selection: setup.selection ?? null,
  }
}

function Chart({
  setup,
  stable,
  markers,
}: {
  setup: Setup
  stable: ReturnType<typeof stableSlice>
  markers: ReturnType<typeof sales>
}): ReactNode {
  const [hovered, setHovered] = useState<number | null>(setup.tooltipIndex ?? null)
  setHover = setHovered
  const value = { ...stable, tooltipData: tooltipAt(hovered) } as unknown as ChartContextValue
  const children = createElement(
    Fragment,
    null,
    createElement(ChartTooltip, { showDatePill: false }),
    createElement(EventMarkers, {
      anchorKey: "visitors",
      bucketLabel,
      dimOpacity: DIM,
      endMs: START + BUCKETS * DAY,
      items: markers,
      kinds,
      renderContent,
    })
  )
  return createElement(ChartProvider, { value, children })
}

async function render(setup: Setup = {}) {
  host = document.createElement("div")
  document.body.append(host)
  const container = document.createElement("div")
  container.style.position = "relative"
  document.body.append(container)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      createElement(Chart, {
        setup,
        stable: stableSlice(setup, container),
        markers: sales(setup.days ?? [0, 4, 8]),
      })
    )
  })
  // The tooltip mounts its portal after an effect.
  await act(async () => {})
  return container
}

const layer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-chart-layer="markers"]')!
const buckets = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-marker-bucket]")]
const triggers = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("button[aria-label]")]
/** The layer's clip, how far in from the right edge (negative: past it). */
const rightInset = (element: HTMLElement) =>
  Number.parseFloat(/inset\((-?[\d.]+)px (-?[\d.]+)px/.exec(element.style.clipPath)?.[2] ?? "NaN")
const zIndex = (element: Element | null) => Number((element as HTMLElement | null)?.style.zIndex || 0)
const translateX = (element: HTMLElement) =>
  Number(/translate\((-?[\d.]+)px/.exec(element.style.transform)?.[1] ?? Number.NaN)

beforeEach(() => {
  motionPreference.reduced = false
  faceCalls.mockClear()
  setTooltipData.mockClear()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
  host = null
})

describe("the marker layer, drawn into a chart", () => {
  it("lets the pointer through its stems and dots: only a marker's button takes it", async () => {
    const container = await render()
    expect(layer(container).className).toContain("pointer-events-none")
    const stems = container.querySelectorAll("[data-marker-stem]")
    const dots = container.querySelectorAll("[data-marker-dot]")
    expect(stems).toHaveLength(3)
    expect(dots).toHaveLength(3)
    for (const mark of [...stems, ...dots]) {
      expect(mark.className).toContain("pointer-events-none")
      expect(mark.className).not.toContain("pointer-events-auto")
    }
    for (const trigger of triggers(container)) {
      expect(trigger.className).toContain("pointer-events-auto")
    }
  })

  it("sits above the crosshair line and below the crosshair's dots", async () => {
    const container = await render({ tooltipIndex: 4 })
    const line = container.querySelector('[data-chart-layer="crosshair-line"]')
    const dots = container.querySelector('[data-chart-layer="crosshair-dots"]')
    expect(line).not.toBeNull()
    expect(dots).not.toBeNull()
    expect(zIndex(layer(container))).toBeGreaterThan(zIndex(line))
    expect(zIndex(dots)).toBeGreaterThan(zIndex(layer(container)))
  })

  it("moves with the line, never behind it: no position transition, only the opacity fade", async () => {
    const container = await render()
    for (const element of container.querySelectorAll<HTMLElement>("[data-chart-layer='markers'] *")) {
      expect(element.style.transition).not.toMatch(/transform|clip-path|top|left/)
    }
  })

  it("wipes in with the line's reveal, and is simply there under reduced motion", async () => {
    const revealing = await render({ chartPhase: "revealing" })
    // The reveal starts with everything right of the plot's left edge cut,
    // and opens to the right.
    expect(rightInset(layer(revealing))).toBeGreaterThan(WIDTH / 2)
    await act(async () => root?.unmount())
    document.body.innerHTML = ""

    motionPreference.reduced = true
    const reduced = await render({ chartPhase: "revealing" })
    expect(rightInset(layer(reduced))).toBeLessThanOrEqual(0)
    for (const element of reduced.querySelectorAll<HTMLElement>("[data-chart-layer='markers'] *")) {
      expect(element.style.transition).not.toMatch(/transform|clip-path/)
    }
  })

  it("dims right of the cut the series dim at, and nowhere while the chart can't be used", async () => {
    const tooltip = tooltipAt(4)!
    const cut = scrubDimCut({
      dimOpacity: DIM,
      canInteract: true,
      tooltipX: tooltip.x,
      selecting: false,
      innerWidth: WIDTH,
      columnWidth: 45,
    })!
    const container = await render({ tooltipIndex: 4 })
    const opacities = buckets(container).map((bucket) => Number(bucket.style.opacity))
    const xs = [0, 4, 8].map((day) => xScale(data[day]!.date))
    expect(opacities).toEqual(xs.map((x) => (x > cut ? DIM : 1)))
    expect(opacities).toEqual([1, 1, DIM])

    await act(async () => root?.unmount())
    document.body.innerHTML = ""
    // While selecting, as the series: no dim.
    const selecting = await render({ tooltipIndex: 4, selection: { active: true } as ChartSelection })
    expect(buckets(selecting).map((bucket) => Number(bucket.style.opacity))).toEqual([1, 1, 1])

    await act(async () => root?.unmount())
    document.body.innerHTML = ""
    // Nor while the chart is still wiping in and can't be scrubbed.
    const revealing = await render({ tooltipIndex: 4, chartPhase: "revealing" })
    expect(buckets(revealing).map((bucket) => Number(bucket.style.opacity))).toEqual([1, 1, 1])
  })

  it("keeps the anchor dot on the true point at the chart's first bucket", async () => {
    const container = await render({ days: [0] })
    const dot = container.querySelector<HTMLElement>("[data-marker-dot]")!
    const size = Number.parseFloat(dot.style.width)
    expect(translateX(dot)).toBe(xScale(data[0]!.date) - size / 2)
  })

  it("draws each bucket's faces once, not on every move of the crosshair", async () => {
    await render()
    const drawn = faceCalls.mock.calls.length
    expect(drawn).toBe(3)
    for (const index of [1, 2, 3, 5, null]) {
      await act(async () => setHover(index))
    }
    expect(faceCalls.mock.calls.length).toBe(drawn)
  })

  it("puts the chart tooltip away when the pointer enters a face, but not on a dense chart", async () => {
    const faces = await render({ tooltipIndex: 4 })
    await act(async () => {
      triggers(faces)[0]!.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
      )
    })
    expect(setTooltipData).toHaveBeenCalledWith(null)

    await act(async () => root?.unmount())
    document.body.innerHTML = ""
    setTooltipData.mockClear()
    const dense = await render({ tooltipIndex: 4, columnWidth: 10 })
    await act(async () => {
      triggers(dense)[0]!.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
      )
    })
    expect(setTooltipData).not.toHaveBeenCalled()
  })

  it("keeps a dense chart's hit areas inside their own columns", async () => {
    const dense = await render({ columnWidth: 10 })
    for (const trigger of triggers(dense)) {
      expect(Number.parseFloat(trigger.style.width)).toBeLessThanOrEqual(10)
    }
  })
})
