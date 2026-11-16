import {
  MENTION_AUTHOR_NAME_MAX_LENGTH,
  MENTION_TEXT_MAX_LENGTH,
  linksToSite,
  mentionQueries,
  normalizeMentionSettingsPatch,
  parseFxTwitterSearch,
  sniffMentionAvatarType,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'
import { fxSearchBody, fxStatus, fxStatusWithId } from '../support/fxtwitter-fixtures.ts'

/**
 * The pure half of X mentions: reading an fxtwitter search response, deciding
 * whether a post links to the site, normalizing the settings patch and turning
 * settings into search queries.
 *
 * The parser is deliberately tolerant per result and strict per document: one
 * odd post is skipped, but a body that is not a search response at all is a
 * failure the poller records as `invalid_response`, never an empty page that
 * would read as "nobody mentioned you".
 */

describe('parseFxTwitterSearch', () => {
  it('reads a real search result', () => {
    const parsed = parseFxTwitterSearch(fxSearchBody([fxStatus]))
    expect(parsed).toEqual({
      ok: true,
      nextCursor: 'cursor-bottom-1',
      posts: [
        {
          postId: '2119776680621285605',
          url: 'https://x.com/hampfh/status/2119776680621285605',
          text: "I'm so sad to se https://conductor.build go away...",
          authorHandle: 'hampfh',
          authorName: 'Hampus Hallkvist',
          authorUrl: 'https://x.com/hampfh',
          authorFollowers: 5,
          likes: 1,
          reposts: 0,
          replies: 1,
          quotes: 0,
          views: 23,
          postedAt: new Date(1794229118 * 1000),
          linkHosts: ['conductor.build'],
          authorAvatarSourceUrl: 'https://pbs.twimg.com/profile_images/1/avatar.jpg',
        },
      ],
    })
  })

  it('never carries the language or the raw facets', () => {
    const parsed = parseFxTwitterSearch(fxSearchBody([fxStatus]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const post = parsed.posts[0] as unknown as Record<string, unknown>
    expect(post).not.toHaveProperty('lang')
    expect(post).not.toHaveProperty('raw_text')
    expect(post).not.toHaveProperty('avatar_url')
  })

  it('keeps the avatar source only when it is https on pbs.twimg.com exactly', () => {
    const avatarOf = (avatarUrl: unknown) => {
      const parsed = parseFxTwitterSearch(
        fxSearchBody([{ ...fxStatus, author: { ...fxStatus.author, avatar_url: avatarUrl } }]),
      )
      if (!parsed.ok) throw new Error('fixture did not parse')
      return parsed.posts[0]?.authorAvatarSourceUrl
    }
    expect(avatarOf('https://pbs.twimg.com/profile_images/1/a.jpg')).toBe(
      'https://pbs.twimg.com/profile_images/1/a.jpg',
    )
    for (const refused of [
      'http://pbs.twimg.com/profile_images/1/a.jpg',
      'https://abs.twimg.com/profile_images/1/a.jpg',
      'https://pbs.twimg.com.evil.com/profile_images/1/a.jpg',
      'https://evil.com/pbs.twimg.com/a.jpg',
      'https://user:pw@pbs.twimg.com/profile_images/1/a.jpg',
      'https://pbs.twimg.com:8443/profile_images/1/a.jpg',
      'javascript:alert(1)//pbs.twimg.com/a.jpg',
      'data:image/png;base64,AAAA',
      '//pbs.twimg.com/profile_images/1/a.jpg',
      '/profile_images/1/a.jpg',
      'not a url',
      '',
      42,
      null,
      undefined,
    ]) {
      expect(avatarOf(refused), String(refused)).toBeNull()
    }
    // A missing avatar never costs the post.
    const { avatar_url: _dropped, ...authorWithout } = fxStatus.author
    const parsed = parseFxTwitterSearch(fxSearchBody([{ ...fxStatus, author: authorWithout }]))
    expect(parsed.ok && parsed.posts[0]?.authorAvatarSourceUrl).toBeNull()
  })

  it('asks for the 48 px variant of a sized avatar and leaves an unsized one alone', () => {
    const avatarOf = (avatarUrl: string) => {
      const parsed = parseFxTwitterSearch(
        fxSearchBody([{ ...fxStatus, author: { ...fxStatus.author, avatar_url: avatarUrl } }]),
      )
      if (!parsed.ok) throw new Error('fixture did not parse')
      return parsed.posts[0]?.authorAvatarSourceUrl
    }
    const base = 'https://pbs.twimg.com/profile_images/1234/AbC_d'
    expect(avatarOf(`${base}_200x200.jpg`)).toBe(`${base}_normal.jpg`)
    expect(avatarOf(`${base}_400x400.png`)).toBe(`${base}_normal.png`)
    expect(avatarOf(`${base}_bigger.jpeg`)).toBe(`${base}_normal.jpeg`)
    expect(avatarOf(`${base}_normal.webp`)).toBe(`${base}_normal.webp`)
    expect(avatarOf(`${base}.jpg`)).toBe(`${base}.jpg`)
    expect(avatarOf('https://pbs.twimg.com/profile_images/1/avatar.jpg')).toBe(
      'https://pbs.twimg.com/profile_images/1/avatar.jpg',
    )
  })

  it('skips results that are not statuses or lack an identity', () => {
    const parsed = parseFxTwitterSearch(
      fxSearchBody([
        { ...fxStatus, type: 'user' },
        fxStatusWithId('1', { id: undefined }),
        fxStatusWithId('3', { author: { name: 'No handle' } }),
        fxStatusWithId('4', { created_timestamp: 'yesterday' }),
        null,
        'a string',
        fxStatusWithId('5'),
      ]),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.posts.map((post) => post.postId)).toEqual(['5'])
  })

  it('builds both links from the handle and id, never from the upstream fields', () => {
    const parsed = parseFxTwitterSearch(
      fxSearchBody([
        fxStatusWithId('11', {
          url: 'javascript:alert(1)',
          author: { ...fxStatus.author, url: 'data:text/html,<script>alert(1)</script>' },
        }),
        fxStatusWithId('12', {
          url: '/relative/path',
          author: { ...fxStatus.author, url: '//evil.example/hampfh' },
        }),
        fxStatusWithId('13', { url: undefined, author: { screen_name: 'hampfh' } }),
      ]),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.posts.map((post) => [post.url, post.authorUrl])).toEqual([
      ['https://x.com/hampfh/status/11', 'https://x.com/hampfh'],
      ['https://x.com/hampfh/status/12', 'https://x.com/hampfh'],
      ['https://x.com/hampfh/status/13', 'https://x.com/hampfh'],
    ])
  })

  it('skips a result whose handle or id is not the platform shape', () => {
    const author = (screen_name: unknown) => ({ ...fxStatus.author, screen_name })
    const parsed = parseFxTwitterSearch(
      fxSearchBody([
        fxStatusWithId('21', { author: author('evil/../x') }),
        fxStatusWithId('22', { author: author('a'.repeat(16)) }),
        fxStatusWithId('23', { author: author('with space') }),
        fxStatusWithId('24', { author: author('javascript:x') }),
        fxStatusWithId('abc'),
        fxStatusWithId('1'.repeat(26)),
        fxStatusWithId('12/34'),
        fxStatusWithId('25', { id: 25 }),
        fxStatusWithId('26', { author: author('Under_Score_15c') }),
      ]),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.posts.map((post) => post.postId)).toEqual(['26'])
  })

  it('strips NUL and other control characters, keeping newlines and tabs', () => {
    const parsed = parseFxTwitterSearch(
      fxSearchBody(
        [
          fxStatusWithId('31', {
            text: 'a\u0000b\u0007c\r\nd\te\u001f',
            author: { ...fxStatus.author, name: 'Ha\u0000mpus\u001b' },
          }),
          fxStatusWithId('32', { author: { ...fxStatus.author, name: '\u0000\u0001' } }),
        ],
        'cur\u0000sor',
      ),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.posts[0]?.text).toBe('abc\nd\te')
    expect(parsed.posts[0]?.authorName).toBe('Hampus')
    // A name that is nothing but control characters falls back to the handle.
    expect(parsed.posts[1]?.authorName).toBe('hampfh')
    expect(parsed.nextCursor).toBe('cursor')
  })

  it('cuts the display name at 100 characters', () => {
    const parsed = parseFxTwitterSearch(
      fxSearchBody([
        fxStatusWithId('41', { author: { ...fxStatus.author, name: 'n'.repeat(500) } }),
      ]),
    )
    expect(parsed.ok && parsed.posts[0]?.authorName.length).toBe(MENTION_AUTHOR_NAME_MAX_LENGTH)
    expect(MENTION_AUTHOR_NAME_MAX_LENGTH).toBe(100)
  })

  it('cuts text at 1000 characters', () => {
    const parsed = parseFxTwitterSearch(
      fxSearchBody([fxStatusWithId('9', { text: 'a'.repeat(5000) })]),
    )
    expect(parsed.ok && parsed.posts[0]?.text.length).toBe(MENTION_TEXT_MAX_LENGTH)
  })

  it('turns counts that are not non-negative integers into null, and clamps int4 counts', () => {
    const parsed = parseFxTwitterSearch(
      fxSearchBody([
        fxStatusWithId('9', {
          likes: -1,
          reposts: 1.5,
          replies: 'many',
          quotes: 2 ** 40,
          views: Number.POSITIVE_INFINITY,
          author: { screen_name: 'x', followers: null },
        }),
      ]),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const post = parsed.posts[0]
    expect(post?.likes).toBeNull()
    expect(post?.reposts).toBeNull()
    expect(post?.replies).toBeNull()
    expect(post?.quotes).toBe(2_147_483_647)
    expect(post?.views).toBeNull()
    expect(post?.authorFollowers).toBeNull()
    // A missing display name and profile link fall back to the handle.
    expect(post?.authorName).toBe('x')
    expect(post?.authorUrl).toBe('https://x.com/x')
  })

  it('collects only url facets with a parseable replacement, lowercased', () => {
    const parsed = parseFxTwitterSearch(
      fxSearchBody([
        fxStatusWithId('9', {
          raw_text: {
            text: '',
            facets: [
              { type: 'url', replacement: 'https://Blog.Conductor.build/post' },
              { type: 'mention', replacement: 'https://not-a-link.example' },
              { type: 'url', replacement: 'not a url' },
              { type: 'url' },
            ],
          },
        }),
      ]),
    )
    expect(parsed.ok && parsed.posts[0]?.linkHosts).toEqual(['blog.conductor.build'])
  })

  it('reports a null cursor when the response has no bottom cursor', () => {
    const parsed = parseFxTwitterSearch(fxSearchBody([], null))
    expect(parsed).toEqual({ ok: true, posts: [], nextCursor: null })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'hello'],
    ['no results', { code: 200 }],
    ['results not an array', { code: 200, results: {} }],
    ['an error code', { code: 500, results: [] }],
  ])('refuses a body that is %s', (_label, body) => {
    const parsed = parseFxTwitterSearch(body)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.detail.length).toBeGreaterThan(0)
  })
})

describe('linksToSite', () => {
  it('matches the domain itself and its subdomains, case-insensitively', () => {
    expect(linksToSite(['conductor.build'], ['conductor.build'])).toBe(true)
    expect(linksToSite(['Docs.Conductor.Build'], ['conductor.build'])).toBe(true)
    expect(linksToSite(['www.conductor.build'], ['conductor.build'])).toBe(true)
    expect(linksToSite(['conductor.build'], ['WWW.conductor.build'])).toBe(true)
  })

  it('does not match a host that merely ends with the same letters', () => {
    expect(linksToSite(['notconductor.build'], ['conductor.build'])).toBe(false)
    expect(linksToSite(['conductor.build.evil.com'], ['conductor.build'])).toBe(false)
  })

  it('is false with no links or no domains', () => {
    expect(linksToSite([], ['conductor.build'])).toBe(false)
    expect(linksToSite(['conductor.build'], [])).toBe(false)
  })

  it('checks every site domain', () => {
    expect(linksToSite(['shop.example'], ['example.com', 'shop.example'])).toBe(true)
  })
})

describe('normalizeMentionSettingsPatch', () => {
  const codes = (result: ReturnType<typeof normalizeMentionSettingsPatch>): string[] =>
    result.ok ? [] : result.issues.map((issue) => `${issue.field}:${issue.code}`)

  it('takes only the fields the caller sent', () => {
    expect(normalizeMentionSettingsPatch({ x_enabled: true }, 'conductor.build')).toEqual({
      ok: true,
      value: { xEnabled: true },
    })
  })

  it('refuses an empty body and a non-object', () => {
    expect(codes(normalizeMentionSettingsPatch({}, 'conductor.build'))).toEqual([
      'body:required_one_of',
    ])
    expect(codes(normalizeMentionSettingsPatch([], 'conductor.build'))).toEqual([
      'body:not_an_object',
    ])
    expect(codes(normalizeMentionSettingsPatch(null, 'conductor.build'))).toEqual([
      'body:not_an_object',
    ])
  })

  it('refuses unknown keys and wrong types', () => {
    expect(codes(normalizeMentionSettingsPatch({ domain: 'x.com' }, 'conductor.build'))).toEqual([
      'domain:unknown',
    ])
    expect(codes(normalizeMentionSettingsPatch({ x_enabled: 'yes' }, 'conductor.build'))).toEqual([
      'x_enabled:not_a_boolean',
    ])
    expect(codes(normalizeMentionSettingsPatch({ terms: 'Conductor' }, 'conductor.build'))).toEqual(
      ['terms:not_an_array'],
    )
  })

  it('trims, dedupes case-insensitively and drops the site domain', () => {
    const result = normalizeMentionSettingsPatch(
      { terms: ['  Conductor  ', 'conductor', 'Conductor.Build', 'www.conductor.build', 'My App'] },
      'conductor.build',
    )
    expect(result).toEqual({ ok: true, value: { terms: ['Conductor', 'My App'] } })
  })

  it('accepts an empty list, which clears the terms', () => {
    expect(normalizeMentionSettingsPatch({ terms: [] }, 'conductor.build')).toEqual({
      ok: true,
      value: { terms: [] },
    })
  })

  it('bounds the count and each term', () => {
    expect(
      codes(normalizeMentionSettingsPatch({ terms: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] }, 'x.y')),
    ).toEqual(['terms:too_many'])
    expect(
      codes(normalizeMentionSettingsPatch({ terms: ['ok', ' a ', 'b'.repeat(65), 7] }, 'x.y')),
    ).toEqual(['terms.1:invalid_length', 'terms.2:invalid_length', 'terms.3:not_a_string'])
  })

  it('works for a site with no domain', () => {
    expect(normalizeMentionSettingsPatch({ terms: ['Conductor'] }, null)).toEqual({
      ok: true,
      value: { terms: ['Conductor'] },
    })
  })
})

describe('sniffMentionAvatarType', () => {
  const bytes = (...values: number[]) => new Uint8Array(values)
  const ascii = (text: string) => new TextEncoder().encode(text)

  it('reads JPEG, PNG and WebP from their magic bytes', () => {
    expect(sniffMentionAvatarType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe('image/jpeg')
    expect(
      sniffMentionAvatarType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)),
    ).toBe('image/png')
    const webp = new Uint8Array([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 ')])
    expect(sniffMentionAvatarType(webp)).toBe('image/webp')
  })

  it('refuses everything else, however it starts', () => {
    expect(sniffMentionAvatarType(new Uint8Array())).toBeNull()
    expect(sniffMentionAvatarType(bytes(0xff, 0xd8))).toBeNull()
    expect(sniffMentionAvatarType(ascii('<!doctype html><svg/>'))).toBeNull()
    expect(sniffMentionAvatarType(ascii('GIF89a......'))).toBeNull()
    expect(sniffMentionAvatarType(ascii('RIFF....WAVEfmt '))).toBeNull()
    expect(sniffMentionAvatarType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull()
  })
})

describe('mentionQueries', () => {
  it('searches the bare domain first, then each term as an exact phrase', () => {
    expect(mentionQueries('conductor.build', ['Conductor', 'My App'])).toEqual([
      'conductor.build',
      '"Conductor"',
      '"My App"',
    ])
  })

  it('strips double quotes inside a term so the phrase stays one phrase', () => {
    expect(mentionQueries('a.b', ['say "hi"'])).toEqual(['a.b', '"say hi"'])
  })

  it('searches only the terms when the site has no domain', () => {
    expect(mentionQueries(null, ['Conductor'])).toEqual(['"Conductor"'])
  })
})
