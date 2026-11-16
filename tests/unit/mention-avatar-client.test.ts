import { MENTION_AVATAR_MAX_BYTES, createMentionAvatarClient } from '@openanalytics/integrations'
import { describe, expect, it } from 'vitest'

/**
 * The avatar download client (migration 0049).
 *
 * It fetches one small picture from `pbs.twimg.com` and nothing else: the URL
 * is re-checked before any request, redirects are refused rather than
 * followed, the body is capped at 32 KB whether or not a length is declared,
 * and the type is read from the bytes — a response header saying `image/png`
 * over an HTML body is refused. Every failure is a value; it never throws.
 */

const SOURCE = 'https://pbs.twimg.com/profile_images/1/a_normal.jpg'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  0x10,
  0,
  0,
  0,
  ...new TextEncoder().encode('WEBPVP8 '),
])

interface Captured {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return respond(url, init)
  }) as typeof fetch
  return { impl, calls }
}

const image = (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
  new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } })

/** A body with no declared length, delivered in `chunks` pieces of `size` bytes. */
function streamed(chunks: number, size: number, first: Uint8Array = JPEG): Response {
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close()
        return
      }
      const chunk = new Uint8Array(size)
      if (sent === 0) chunk.set(first)
      sent += 1
      controller.enqueue(chunk)
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } })
}

describe('mention avatar client', () => {
  it('returns the bytes and the type the bytes say, and refuses redirects', async () => {
    const { impl, calls } = fakeFetch(() => image(JPEG))
    const client = createMentionAvatarClient({ version: '1.2.3' }, impl)

    const result = await client.fetchAvatar(SOURCE)

    expect(result).toEqual({ ok: true, contentType: 'image/jpeg', bytes: JPEG })
    expect(calls).toHaveLength(1)
    const call = calls[0] as Captured
    expect(call.url).toBe(SOURCE)
    expect(call.init?.redirect).toBe('error')
    expect(call.init?.method).toBe('GET')
    expect(call.init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(call.init?.headers)
    expect(headers.get('user-agent')).toMatch(/^OpenAnalytics-Mentions\/1\.2\.3 /u)
    expect(headers.has('cookie')).toBe(false)
    expect(headers.has('authorization')).toBe(false)
  })

  it('reads PNG and WebP from the bytes, whatever the header says', async () => {
    const png = createMentionAvatarClient({}, fakeFetch(() => image(PNG)).impl)
    expect(await png.fetchAvatar(SOURCE)).toMatchObject({ ok: true, contentType: 'image/png' })

    const webp = createMentionAvatarClient(
      {},
      fakeFetch(() => image(WEBP, { 'content-type': 'text/html' })).impl,
    )
    expect(await webp.fetchAvatar(SOURCE)).toMatchObject({ ok: true, contentType: 'image/webp' })
  })

  it('refuses a body whose header says png but whose bytes are HTML or SVG', async () => {
    for (const body of ['<!doctype html><script>x</script>', '<svg onload="x"/>', 'GIF89a....']) {
      const client = createMentionAvatarClient(
        {},
        fakeFetch(() => image(new TextEncoder().encode(body), { 'content-type': 'image/png' }))
          .impl,
      )
      expect(await client.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'unsupported_type' })
    }
    const empty = createMentionAvatarClient({}, fakeFetch(() => image(new Uint8Array())).impl)
    expect(await empty.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'unsupported_type' })
  })

  it('refuses a declared length over 32 KB without reading it', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(JPEG)
        controller.close()
      },
    })
    const client = createMentionAvatarClient(
      {},
      fakeFetch(
        () =>
          new Response(body, {
            status: 200,
            headers: { 'content-length': String(MENTION_AVATAR_MAX_BYTES + 1) },
          }),
      ).impl,
    )
    expect(await client.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'too_large' })
    expect(pulled).toBeLessThanOrEqual(1)
  })

  it('stops reading an undeclared body once it passes 32 KB', async () => {
    const client = createMentionAvatarClient({}, fakeFetch(() => streamed(1000, 4096)).impl)
    expect(await client.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'too_large' })

    // Exactly the cap is still a picture.
    const atCap = createMentionAvatarClient(
      {},
      fakeFetch(() => streamed(8, MENTION_AVATAR_MAX_BYTES / 8)).impl,
    )
    const result = await atCap.fetchAvatar(SOURCE)
    expect(result.ok && result.bytes.byteLength).toBe(MENTION_AVATAR_MAX_BYTES)
  })

  it('never fetches a URL that is not https on pbs.twimg.com', async () => {
    const { impl, calls } = fakeFetch(() => image(JPEG))
    const client = createMentionAvatarClient({}, impl)
    for (const url of [
      'http://pbs.twimg.com/a.jpg',
      'https://pbs.twimg.com.evil.com/a.jpg',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/a.jpg',
      'https://user@pbs.twimg.com/a.jpg',
      'https://pbs.twimg.com:444/a.jpg',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'nonsense',
    ]) {
      expect(await client.fetchAvatar(url), url).toEqual({ ok: false, reason: 'refused' })
    }
    expect(calls).toEqual([])
  })

  it('reports a redirect, a non-2xx answer and a network failure as unavailable', async () => {
    // What `redirect: 'error'` does in a real fetch: the promise rejects.
    const redirect = createMentionAvatarClient(
      {},
      fakeFetch((_url, init) => {
        if (init?.redirect === 'error') throw new TypeError('fetch failed: redirect')
        return image(JPEG)
      }).impl,
    )
    expect(await redirect.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'unavailable' })

    // And a fetch that hands back the 3xx itself is not followed either.
    const manual = createMentionAvatarClient(
      {},
      fakeFetch(
        () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
      ).impl,
    )
    expect(await manual.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'unavailable' })

    const missing = createMentionAvatarClient(
      {},
      fakeFetch(() => new Response('nope', { status: 404 })).impl,
    )
    expect(await missing.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'unavailable' })

    const down = createMentionAvatarClient(
      {},
      fakeFetch(() => {
        throw new Error('ECONNRESET')
      }).impl,
    )
    expect(await down.fetchAvatar(SOURCE)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('gives up as soon as the caller aborts, without throwing', async () => {
    const controller = new AbortController()
    const { impl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          setTimeout(() => controller.abort(), 10)
        }),
    )
    const client = createMentionAvatarClient({}, impl)
    const started = Date.now()
    const result = await client.fetchAvatar(SOURCE, { signal: controller.signal })
    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(Date.now() - started).toBeLessThan(2000)

    // Already aborted: nothing is requested.
    const calls = fakeFetch(() => image(JPEG))
    const aborted = new AbortController()
    aborted.abort()
    const again = createMentionAvatarClient({}, calls.impl)
    expect(await again.fetchAvatar(SOURCE, { signal: aborted.signal })).toEqual({
      ok: false,
      reason: 'unavailable',
    })
    expect(calls.calls).toEqual([])
  })
})
