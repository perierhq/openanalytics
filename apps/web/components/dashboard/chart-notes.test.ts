// @vitest-environment happy-dom
import { act, createElement, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ChartNote } from "@/lib/api"
import { NoteForm, NotesSection, type NoteActions } from "./chart-notes"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const note = (overrides: Partial<ChartNote> = {}): ChartNote => ({
  id: "0190a3b4-0000-7000-8000-000000000001",
  at: "2026-07-11T09:00:00.000Z",
  text: "Launch post went live\nsecond line",
  created_by: { name: "Ada Lovelace" },
  created_at: "2026-07-11T09:05:00.000Z",
  updated_at: "2026-07-11T09:05:00.000Z",
  ...overrides,
})

const actions = () => ({
  timeZone: "Europe/Istanbul",
  create: vi.fn<NoteActions["create"]>(async () => {}),
  update: vi.fn<NoteActions["update"]>(async () => {}),
  remove: vi.fn<NoteActions["remove"]>(async () => {}),
  describeError: () => "Couldn't save",
})

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim()

const section = (canWrite: boolean, notes: ChartNote[] = [note()]) =>
  renderToStaticMarkup(
    createElement(NotesSection, {
      notes,
      bucketStartMs: Date.parse("2026-07-11T00:00:00.000Z"),
      timeLabel: () => "12:00",
      actions: canWrite ? actions() : null,
    })
  )

describe("the notes in a marker's popover", () => {
  it("lists each note's text, author and time", () => {
    const out = text(section(false, [note(), note({ id: "n2", created_by: null, text: "Ghost" })]))
    expect(out).toContain("2 notes")
    expect(out).toContain("Launch post went live second line")
    expect(out).toContain("Ada Lovelace")
    expect(out).toContain("12:00")
    // A note whose author is gone names nobody, and still shows.
    expect(out).toContain("Ghost")
  })

  it("keeps the note's own line breaks", () => {
    expect(section(false)).toContain("whitespace-pre-line")
  })

  it("gives a viewer no way to add, edit or delete", () => {
    const out = text(section(false))
    expect(out).not.toContain("Edit")
    expect(out).not.toContain("Delete")
    expect(out).not.toContain("Add note")
  })

  it("gives an owner or admin edit and delete on every note, and add for the bucket", () => {
    const html = section(true, [note(), note({ id: "n2" })])
    const out = text(html)
    expect(out.match(/Edit/g)).toHaveLength(2)
    expect(out.match(/Delete/g)).toHaveLength(2)
    expect(out).toContain("Add note")
    // Named per note, so a screen reader hears which one it is.
    expect(html).toContain('aria-label="Edit note: Launch post went live')
  })

  it("offers an owner or admin a note in a bucket that has none yet", () => {
    expect(text(section(true, []))).toContain("Add note")
    expect(section(false, [])).toBe("")
  })
})

describe("the note form", () => {
  const form = (props: Partial<Parameters<typeof NoteForm>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(NoteForm, {
        timeZone: "Europe/Istanbul",
        initialAtMs: Date.parse("2026-07-11T09:00:00.000Z"),
        submitLabel: "Add note",
        onSubmit: async () => {},
        onCancel: () => {},
        ...props,
      })
    )

  it("starts on the chart's own clock and names the zone", () => {
    const html = form()
    // 09:00 UTC is 12:00 in Istanbul.
    expect(html).toContain('value="2026-07-11T12:00"')
    expect(html).toContain('type="datetime-local"')
    expect(text(html)).toContain("Europe/Istanbul")
  })

  it("starts the counter at the text it was given", () => {
    const html = form({ initialText: "Launch" })
    expect(text(html)).toContain("6/280")
    expect(html).toContain("Launch</textarea>")
  })

  it("cannot be saved empty", () => {
    expect(form()).toMatch(/<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/)
  })
})

/* ------------------------------------------------------------------ */
/* In a DOM: keys, limits, what an edit sends, and where focus goes    */
/* ------------------------------------------------------------------ */

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const mount = (element: ReactElement): HTMLElement => {
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(element))
  return host
}

/** Types into a controlled field the way React hears it. */
const typeInto = (field: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto =
    field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  act(() => {
    setter?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

const press = (target: Element, init: KeyboardEventInit) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
  })

/** The button whose accessible name (label or text) matches. */
const buttonNamed = (scope: ParentNode, name: string | RegExp): HTMLButtonElement => {
  const matches = (value: string) =>
    typeof name === "string" ? value === name : name.test(value)
  const found = [...scope.querySelectorAll("button")].find((candidate) =>
    matches(candidate.getAttribute("aria-label") ?? candidate.textContent?.trim() ?? "")
  )
  if (!found) throw new Error(`no button named ${String(name)}`)
  return found
}

const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click()
    await Promise.resolve()
  })
}

const textarea = (scope: ParentNode) => scope.querySelector("textarea") as HTMLTextAreaElement
const submitButton = (scope: ParentNode) =>
  scope.querySelector('button[type="submit"]') as HTMLButtonElement

describe("the note form, in a DOM", () => {
  const formIn = (props: Partial<Parameters<typeof NoteForm>[0]> = {}) => {
    const onSubmit = vi.fn(async () => {})
    const onCancel = vi.fn()
    const outside = vi.fn()
    const el = mount(
      createElement(
        "div",
        { onKeyDown: outside },
        createElement(NoteForm, {
          timeZone: "Europe/Istanbul",
          initialAtMs: Date.parse("2026-07-11T09:00:00.000Z"),
          submitLabel: "Add note",
          onSubmit,
          onCancel,
          ...props,
        })
      )
    )
    return { el, onSubmit, onCancel, outside }
  }

  it("leaves only the form on Escape, never the popover around it", () => {
    const { el, onCancel, outside } = formIn({ initialText: "Launch" })
    press(textarea(el), { key: "Escape" })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(outside).not.toHaveBeenCalled()
  })

  it("saves on ⌘+Enter and Ctrl+Enter, and Enter alone is a new line", async () => {
    const { el, onSubmit } = formIn()
    typeInto(textarea(el), "Launch")
    press(textarea(el), { key: "Enter" })
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => {
      press(textarea(el), { key: "Enter", metaKey: true })
      await Promise.resolve()
    })
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Launch" }))
    await act(async () => {
      press(textarea(el), { key: "Enter", ctrlKey: true })
      await Promise.resolve()
    })
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it("holds 280 characters: 280 saves, 281 does not, and the counter says so", () => {
    const { el } = formIn()
    const counter = () => el.querySelector('[id$="-count"]') as HTMLElement
    typeInto(textarea(el), "a".repeat(280))
    expect(counter().textContent).toBe("280/280")
    expect(counter().className).not.toContain("text-destructive")
    expect(textarea(el).getAttribute("aria-invalid")).toBeNull()
    expect(submitButton(el).disabled).toBe(false)

    typeInto(textarea(el), "a".repeat(281))
    expect(counter().textContent).toBe("281/280")
    expect(counter().className).toContain("text-destructive")
    expect(textarea(el).getAttribute("aria-invalid")).toBe("true")
    expect(submitButton(el).disabled).toBe(true)
  })

  it("counts a Windows line break as one character, as the server does", () => {
    // 140 + CRLF + 140: 282 raw, 281 once folded, so one over.
    const over = formIn({ initialText: `${"a".repeat(140)}\r\n${"a".repeat(140)}` })
    expect(submitButton(over.el).disabled).toBe(true)
    act(() => root?.unmount())
    host?.remove()
    // 139 + CRLF + 140: 281 raw, 280 folded, so it fits.
    const fits = formIn({ initialText: `${"a".repeat(139)}\r\n${"a".repeat(140)}` })
    expect(submitButton(fits.el).disabled).toBe(false)
  })

  it("announces the count only near the limit", () => {
    const { el } = formIn()
    const live = () => el.querySelector('[aria-live="polite"]')
    typeInto(textarea(el), "a".repeat(6))
    // Nothing is read out while there is plenty of room.
    expect(live()?.textContent ?? "").toBe("")
    typeInto(textarea(el), "a".repeat(260))
    expect(live()?.textContent).toBe("260 of 280 characters")
    typeInto(textarea(el), "a".repeat(281))
    expect(live()?.textContent).toBe("281 of 280 characters")
  })
})

describe("editing and deleting in the popover, in a DOM", () => {
  const ZONE = "Europe/Istanbul"

  /** The section over a list the writes really change, like the dashboard's. */
  function Harness({
    initial,
    writes,
    control,
  }: {
    initial: ChartNote[]
    writes: ReturnType<typeof actions> & { outside: () => void }
    control: { setNotes?: (notes: ChartNote[]) => void }
  }) {
    const [notes, setNotes] = useState(initial)
    control.setNotes = setNotes
    return createElement(
      "div",
      { onKeyDown: writes.outside },
      createElement(NotesSection, {
        notes,
        bucketStartMs: Date.parse("2026-07-11T00:00:00.000Z"),
        timeLabel: () => "12:00",
        actions: {
          ...writes,
          remove: async (id: string) => {
            await writes.remove(id)
            setNotes((current) => current.filter((entry) => entry.id !== id))
          },
        },
      })
    )
  }

  const popover = (initial: ChartNote[] = [note()]) => {
    const writes = { ...actions(), timeZone: ZONE, outside: vi.fn() }
    const control: { setNotes?: (notes: ChartNote[]) => void } = {}
    const el = mount(createElement(Harness, { initial, writes, control }))
    return { el, writes, control }
  }

  it("sends nothing for an edit that changed nothing", async () => {
    const { el, writes } = popover()
    await click(buttonNamed(el, /^Edit note/))
    await click(buttonNamed(el, "Save"))
    expect(writes.update).not.toHaveBeenCalled()
    expect(el.querySelector("form")).toBeNull()
  })

  it("keeps the time when only the text changed, even a time off the minute", async () => {
    const { el, writes } = popover([note({ at: "2026-07-11T09:00:30.000Z" })])
    await click(buttonNamed(el, /^Edit note/))
    typeInto(textarea(el), "Launch post went live")
    await click(buttonNamed(el, "Save"))
    expect(writes.update).toHaveBeenCalledWith(note().id, { text: "Launch post went live" })
  })

  it("sends the time, and only the time, when only the time changed", async () => {
    const { el, writes } = popover()
    await click(buttonNamed(el, /^Edit note/))
    typeInto(el.querySelector('input[type="datetime-local"]') as HTMLInputElement, "2026-07-11T13:00")
    await click(buttonNamed(el, "Save"))
    // 13:00 in Istanbul is 10:00 UTC.
    expect(writes.update).toHaveBeenCalledWith(note().id, { at: "2026-07-11T10:00:00.000Z" })
  })

  it("puts focus on Cancel when Delete asks to confirm", async () => {
    const { el } = popover()
    await click(buttonNamed(el, /^Delete note/))
    expect(document.activeElement).toBe(buttonNamed(el, "Cancel"))
  })

  it("closes only the confirmation on Escape, and returns to its Delete", async () => {
    const { el, writes } = popover()
    await click(buttonNamed(el, /^Delete note/))
    press(buttonNamed(el, "Cancel"), { key: "Escape" })
    expect(writes.outside).not.toHaveBeenCalled()
    expect(el.textContent).not.toContain("for everyone on the site")
    expect(document.activeElement).toBe(buttonNamed(el, /^Delete note/))
  })

  it("returns to Edit when an edit is cancelled or saved", async () => {
    const { el } = popover([note(), note({ id: "n2", text: "Second" })])
    await click(buttonNamed(el, "Edit note: Second"))
    await click(buttonNamed(el, "Cancel"))
    expect(document.activeElement).toBe(buttonNamed(el, "Edit note: Second"))

    await click(buttonNamed(el, "Edit note: Second"))
    typeInto(textarea(el), "Second, edited")
    await click(buttonNamed(el, "Save"))
    expect(document.activeElement).toBe(buttonNamed(el, "Edit note: Second"))
  })

  it("lands on Add note once a deleted note's own buttons are gone", async () => {
    const { el, writes } = popover([note(), note({ id: "n2", text: "Second" })])
    await click(buttonNamed(el, "Delete note: Second"))
    await click(buttonNamed(el, "Delete"))
    expect(writes.remove).toHaveBeenCalledWith("n2")
    expect(el.textContent).not.toContain("Second")
    expect(document.activeElement).toBe(buttonNamed(el, "Add note"))
  })

  // A focused button that turns disabled drops focus to the page, and the
  // popover then pulls it to its own container a frame later, over wherever
  // the close put it. So nothing the section disables may hold focus.
  it("moves focus off Save before Save waits disabled", async () => {
    const { el, writes } = popover()
    writes.update.mockImplementation(() => new Promise<void>(() => {}))
    await click(buttonNamed(el, /^Edit note/))
    typeInto(textarea(el), "Changed")
    const save = buttonNamed(el, "Save")
    save.focus()
    await click(save)
    expect(save.disabled).toBe(true)
    expect(document.activeElement).toBe(textarea(el))
  })

  it("moves focus off the confirming Delete before it waits disabled", async () => {
    const { el, writes } = popover()
    writes.remove.mockImplementation(() => new Promise<void>(() => {}))
    await click(buttonNamed(el, /^Delete note/))
    const confirm = buttonNamed(el, "Delete")
    confirm.focus()
    await click(confirm)
    expect(confirm.disabled).toBe(true)
    const active = document.activeElement as HTMLElement
    expect(active.getAttribute("aria-label")).toBe("Confirm delete")
    expect(active.contains(confirm)).toBe(true)
  })

  // The dashboard drops the note from its list before the delete's promise
  // settles, so the row that held focus goes one render before the close.
  it("catches focus in the same render when the row holding it goes", async () => {
    const { el, writes, control } = popover([note(), note({ id: "n2", text: "Second" })])
    writes.remove.mockImplementation(() => new Promise<void>(() => {}))
    await click(buttonNamed(el, "Delete note: Second"))
    const confirm = buttonNamed(el, "Delete")
    confirm.focus()
    await click(confirm)
    act(() => control.setNotes?.([note()]))
    expect(document.activeElement).toBe(buttonNamed(el, "Add note"))
  })

  it("puts focus back on Cancel when a delete fails", async () => {
    const { el, writes } = popover()
    writes.remove.mockRejectedValueOnce(new Error("500"))
    await click(buttonNamed(el, /^Delete note/))
    await click(buttonNamed(el, "Delete"))
    expect(el.textContent).toContain("Couldn't save")
    expect(document.activeElement).toBe(buttonNamed(el, "Cancel"))
  })

  it("returns to Add note when adding is cancelled", async () => {
    const { el } = popover()
    await click(buttonNamed(el, "Add note"))
    await click(buttonNamed(el, "Cancel"))
    expect(document.activeElement).toBe(buttonNamed(el, "Add note"))
  })
})
