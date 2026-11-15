import { FXTWITTER_SEARCH_COUNT, createFxTwitterClient } from '@openanalytics/integrations'
import { describe, expect, it } from 'vitest'
import { fxSearchBody, fxStatus } from '../support/fxtwitter-fixtures.ts'

/**
 * The fxtwitter search client: one GET, no auth, and every failure a typed
 * outcome rather than a throw. The poller shares a process with batch ingest,
 * so "the search service is down" must come back as a value it can record.
 */

interface Captured {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return respond(url)
  }) as typeof fetch
  return { impl, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('fxtwitter search client', () => {
  it('returns the parsed posts and the next cursor', async () => {
    const { impl, calls } = fakeFetch(() => json(fxSearchBody([fxStatus])))
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    const result = await client.search('conductor.build')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.posts.map((post) => post.postId)).toEqual(['2119776680621285605'])
    expect(result.data.nextCursor).toBe('cursor-bottom-1')

    const call = calls[0] as Captured
    const url = new URL(call.url)
    expect(url.origin + url.pathname).toBe('https://api.fxtwitter.com/2/search')
    expect(url.searchParams.get('q')).toBe('conductor.build')
    expect(url.searchParams.get('count')).toBe(String(FXTWITTER_SEARCH_COUNT))
    expect(url.searchParams.has('cursor')).toBe(false)
    const headers = new Headers(call.init?.headers)
    expect(headers.get('user-agent')).toMatch(
      /^OpenAnalytics-Mentions\/\S+ \(\+https:\/\/github\.com\/OpenLabs-so\/openanalytics\)$/u,
    )
    expect(call.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes the cursor through', async () => {
    const { impl, calls } = fakeFetch(() => json(fxSearchBody([])))
    const client = createFxTwitterClient({ baseUrl: 'https://fx.internal/' }, impl)

    await client.search('conductor.build', 'DAABCgABG+abc==')

    const url = new URL((calls[0] as Captured).url)
    expect(url.origin + url.pathname).toBe('https://fx.internal/2/search')
    expect(url.searchParams.get('cursor')).toBe('DAABCgABG+abc==')
  })

  it('URL-encodes a quoted phrase', async () => {
    const { impl, calls } = fakeFetch(() => json(fxSearchBody([])))
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    await client.search('"My App"')

    const raw = (calls[0] as Captured).url
    expect(raw).toContain('q=%22My+App%22')
    expect(new URL(raw).searchParams.get('q')).toBe('"My App"')
  })

  it('reports a non-2xx answer as unavailable', async () => {
    const { impl } = fakeFetch(() => json({ code: 500, message: 'secret upstream detail' }, 503))
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    const result = await client.search('conductor.build')

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('secret upstream detail')
  })

  it('reports a network failure as unavailable, without throwing', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    await expect(client.search('conductor.build')).resolves.toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
  })

  it('reports a body that is not JSON as invalid_response', async () => {
    const { impl } = fakeFetch(() => new Response('<html>blocked</html>', { status: 200 }))
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    await expect(client.search('conductor.build')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_response',
    })
  })

  it('reports JSON that is not a search response as invalid_response', async () => {
    const { impl } = fakeFetch(() => json({ hello: 'world' }))
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    await expect(client.search('conductor.build')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_response',
    })
  })

  it('refuses a body that declares more than 2 MB, without reading it', async () => {
    let read = false
    // High-water mark 0, so `pull` runs only when somebody reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true
          controller.enqueue(new TextEncoder().encode(JSON.stringify(fxSearchBody([]))))
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const { impl } = fakeFetch(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': '2000001' },
        }),
    )
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    await expect(client.search('conductor.build')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_response',
    })
    expect(read).toBe(false)
  })

  it('refuses a body over 2 MB that declares no length', async () => {
    // Valid JSON, so only the size cap can refuse it.
    const padded = JSON.stringify({ ...fxSearchBody([]), pad: 'x'.repeat(2_000_000) })
    const { impl } = fakeFetch(() => new Response(padded, { status: 200 }))
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    await expect(client.search('conductor.build')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_response',
    })
  })

  it('hands the caller signal to fetch, alongside its own deadline', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }) as typeof fetch
    const client = createFxTwitterClient({ baseUrl: 'https://api.fxtwitter.com' }, impl)

    const pending = client.search('conductor.build', undefined, { signal: controller.signal })
    controller.abort()

    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'unavailable' })
    expect(seen?.aborted).toBe(true)
  })
})
