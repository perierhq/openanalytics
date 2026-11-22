import { describe, expect, it } from "vitest"

import type { ChartNote } from "@/lib/api"
import {
  canWriteNotes,
  createMockNoteStore,
  defaultNoteTime,
  fromZonedInput,
  NOTE_TEXT_MAX,
  noteTextLength,
  noteTextProblem,
  toZonedInput,
} from "./chart-notes"

describe("a note's draft text", () => {
  it("is fine from 1 to 280 characters after trimming", () => {
    expect(noteTextProblem("Launched v2")).toBeNull()
    expect(noteTextProblem("x".repeat(NOTE_TEXT_MAX))).toBeNull()
    expect(noteTextProblem("x".repeat(281))).toBe("too_long")
    expect(noteTextProblem("   \n ")).toBe("empty")
  })

  it("counts like the server: trimmed, an emoji is one", () => {
    expect(noteTextLength("  ab  ")).toBe(2)
    expect(noteTextLength("🚀🚀")).toBe(2)
    expect(noteTextProblem("🚀".repeat(280))).toBeNull()
  })

  it("keeps newlines and refuses other control characters", () => {
    expect(noteTextProblem("two\nlines")).toBeNull()
    expect(noteTextProblem("a\tb")).toBe("control_characters")
    expect(noteTextProblem("a\u0007b")).toBe("control_characters")
  })
})

describe("the time field, on the chart's own clock", () => {
  const instant = Date.parse("2026-11-10T12:34:56.000Z")

  it("shows an instant as wall-clock time in the zone, to the minute", () => {
    expect(toZonedInput(instant, "UTC")).toBe("2026-11-10T12:34")
    expect(toZonedInput(instant, "Europe/Istanbul")).toBe("2026-11-10T15:34")
    expect(toZonedInput(instant, "America/Los_Angeles")).toBe("2026-11-10T04:34")
    expect(toZonedInput(instant, "Asia/Kathmandu")).toBe("2026-11-10T18:19")
  })

  it("reads wall-clock time back to the same instant", () => {
    for (const zone of ["UTC", "Europe/Istanbul", "America/Los_Angeles", "Asia/Kathmandu"]) {
      const value = toZonedInput(instant, zone)
      expect(fromZonedInput(value, zone), zone).toBe(Date.parse("2026-11-10T12:34:00.000Z"))
    }
  })

  it("lands on the right side of a clock change", () => {
    // Berlin, 2026-03-29: 02:00 does not exist and 01:59 is still winter time.
    expect(fromZonedInput("2026-03-29T01:59", "Europe/Berlin")).toBe(
      Date.parse("2026-03-29T00:59:00.000Z")
    )
    expect(fromZonedInput("2026-03-29T03:00", "Europe/Berlin")).toBe(
      Date.parse("2026-03-29T01:00:00.000Z")
    )
    // Summer time, either side of the change in the autumn.
    expect(fromZonedInput("2026-07-01T12:00", "Europe/Berlin")).toBe(
      Date.parse("2026-07-01T10:00:00.000Z")
    )
  })

  it("refuses a value that is not a time", () => {
    expect(fromZonedInput("", "UTC")).toBeNull()
    expect(fromZonedInput("tomorrow", "UTC")).toBeNull()
  })

  it("starts a new note at the bucket it came from, or now, on a whole minute", () => {
    expect(defaultNoteTime(instant)).toBe(Date.parse("2026-11-10T12:34:00.000Z"))
    const bucket = Date.parse("2026-11-09T00:00:00.000Z")
    expect(defaultNoteTime(instant, bucket)).toBe(bucket)
  })
})

describe("who writes notes", () => {
  it("is owners and admins; a viewer only reads", () => {
    expect(canWriteNotes("owner")).toBe(true)
    expect(canWriteNotes("admin")).toBe(true)
    expect(canWriteNotes("viewer")).toBe(false)
  })
})

describe("the mock-mode note store", () => {
  const seed: ChartNote = {
    id: "n1",
    at: "2026-07-11T09:00:00.000Z",
    text: "Launch",
    created_by: { name: "Ada Lovelace" },
    created_at: "2026-07-11T09:00:00.000Z",
    updated_at: "2026-07-11T09:00:00.000Z",
  }

  it("stores text the way the server does: line breaks folded, then trimmed", async () => {
    const store = createMockNoteStore([seed], "Grace Hopper")
    const created = await store.create({ at: seed.at, text: "  one\r\ntwo\rthree \r\n" })
    expect(created.text).toBe("one\ntwo\nthree")
    expect(created.created_by).toEqual({ name: "Grace Hopper" })
    const updated = await store.update("n1", { text: "a\r\nb " })
    expect(updated.text).toBe("a\nb")
    expect(updated.at).toBe(seed.at)
  })

  it("lists newest first and forgets a removed note", async () => {
    const store = createMockNoteStore([seed], "Grace Hopper")
    await store.create({ at: "2026-07-12T09:00:00.000Z", text: "Later" })
    expect((await store.list()).items.map((entry) => entry.text)).toEqual(["Later", "Launch"])
    await store.remove("n1")
    expect((await store.list()).items.map((entry) => entry.text)).toEqual(["Later"])
    await expect(store.update("n1", { text: "x" })).rejects.toThrow()
  })
})
