import {
  AI_ASSISTANT_HOSTS,
  CHANNELS,
  CLICK_ID_SOURCES,
  classifyChannel,
  type Channel,
  type ChannelInput,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The channel a sources tuple belongs to.
 *
 * One table per rule, then the conflicts between rules, because the precedence
 * is the part a reader cannot see from the lists: a row matches several rules
 * more often than it matches one, and which one wins is the whole answer.
 */

const row = (input: Partial<ChannelInput>): ChannelInput => ({
  referrerDomain: '',
  utmSource: '',
  utmMedium: '',
  ...input,
})

const cases = (table: readonly [Partial<ChannelInput>, Channel][]) =>
  table.map(([input, channel]) => [JSON.stringify(input), input, channel] as const)

describe('the vocabulary', () => {
  it('names eight channels, in precedence order', () => {
    expect(CHANNELS).toEqual([
      'paid',
      'email',
      'affiliate',
      'ai',
      'organic_search',
      'social',
      'referral',
      'direct',
    ])
  })
})

describe('paid', () => {
  it.each(
    cases([
      [{ utmMedium: 'cpc' }, 'paid'],
      [{ utmMedium: 'ppc' }, 'paid'],
      [{ utmMedium: 'paid' }, 'paid'],
      [{ utmMedium: 'paidsearch' }, 'paid'],
      [{ utmMedium: 'paid_social' }, 'paid'],
      [{ utmMedium: 'display' }, 'paid'],
      [{ utmMedium: 'cpm' }, 'paid'],
      [{ utmMedium: 'ads' }, 'paid'],
      [{ utmMedium: 'paidsocial' }, 'paid'],
      [{ utmMedium: 'paid_media' }, 'paid'],
      [{ utmMedium: 'Paid-Media' }, 'paid'],
      [{ utmMedium: 'banner' }, 'paid'],
      // Case and separators: a CMS writes `Paid-Social`, a person writes `CPC`.
      [{ utmMedium: 'CPC' }, 'paid'],
      [{ utmMedium: ' Paid-Social ' }, 'paid'],
      [{ utmMedium: 'paid social' }, 'paid'],
      [{ utmMedium: 'paid_search' }, 'paid'],
      [{ referrerDomain: 'google.com', utmSource: 'google', utmMedium: 'cpc' }, 'paid'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })

  it('takes every ad click id as paid', () => {
    for (const key of Object.keys(CLICK_ID_SOURCES)) {
      expect(classifyChannel(row({ referrerDomain: 'google.com', clickIdKey: key }))).toBe('paid')
    }
    expect(classifyChannel(row({ clickIdKey: 'GCLID' }))).toBe('paid')
  })

  it('ignores a key that is not a click id', () => {
    expect(classifyChannel(row({ referrerDomain: 'google.com', clickIdKey: 'utm_id' }))).toBe(
      'organic_search',
    )
    expect(classifyChannel(row({ referrerDomain: 'google.com', clickIdKey: '' }))).toBe(
      'organic_search',
    )
  })

  it('does not read a medium that merely contains a paid word', () => {
    expect(classifyChannel(row({ utmMedium: 'unpaid' }))).not.toBe('paid')
    expect(classifyChannel(row({ utmMedium: 'adsense-blog' }))).not.toBe('paid')
  })
})

describe('email', () => {
  it.each(
    cases([
      [{ utmMedium: 'email' }, 'email'],
      [{ utmMedium: 'Newsletter' }, 'email'],
      [{ utmMedium: 'EMAIL' }, 'email'],
      [{ utmSource: 'mailchimp' }, 'email'],
      [{ utmSource: 'Mailchimp' }, 'email'],
      [{ utmSource: 'beehiiv' }, 'email'],
      [{ utmSource: 'ConvertKit' }, 'email'],
      [{ utmSource: 'buttondown.email' }, 'email'],
      [{ utmSource: 'substack' }, 'email'],
      [{ referrerDomain: 'mail.google.com' }, 'email'],
      [{ referrerDomain: 'outlook.live.com' }, 'email'],
      [{ referrerDomain: 'outlook.office.com' }, 'email'],
      [{ referrerDomain: 'mail.yahoo.com' }, 'email'],
      [{ referrerDomain: 'mail.proton.me' }, 'email'],
      [{ referrerDomain: 'app.fastmail.com' }, 'email'],
      [{ referrerDomain: 'navigator.gmx.net' }, 'email'],
      [{ referrerDomain: 'mail.yahoo.co.jp' }, 'email'],
      // The kind of message named in the source, with no medium beside it.
      [{ utmSource: 'newsletter' }, 'email'],
      [{ utmSource: 'Email' }, 'email'],
      // A tool on a second-level suffix: the label left of `co.uk` is the name.
      [{ utmSource: 'mailchimp.co.uk' }, 'email'],
      [{ utmSource: 'klaviyo.com.au' }, 'email'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })
})

describe('affiliate', () => {
  it.each(
    cases([
      [{ utmMedium: 'affiliate' }, 'affiliate'],
      [{ utmMedium: 'Affiliates' }, 'affiliate'],
      [{ utmMedium: 'partner' }, 'affiliate'],
      [{ utmMedium: 'PARTNERS' }, 'affiliate'],
      [{ referrerDomain: 'blog.example.org', utmMedium: 'partner' }, 'affiliate'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })
})

describe('ai', () => {
  it('takes every assistant host as ai', () => {
    for (const host of AI_ASSISTANT_HOSTS) {
      expect(classifyChannel(row({ referrerDomain: host }))).toBe('ai')
    }
  })

  it('takes an assistant’s subdomain as ai', () => {
    expect(classifyChannel(row({ referrerDomain: 'www.perplexity.ai' }))).toBe('ai')
    expect(classifyChannel(row({ referrerDomain: 'labs.perplexity.ai' }))).toBe('ai')
  })

  it.each(
    cases([
      // The assistants' own utm conventions, with no referrer: ChatGPT tags
      // `utm_source=chatgpt.com`, Claude `utm_source=Claude AI` with
      // `utm_medium=claude.ai`.
      [{ utmSource: 'chatgpt.com' }, 'ai'],
      [{ utmSource: 'ChatGPT.com' }, 'ai'],
      [{ utmSource: 'Claude AI' }, 'ai'],
      [{ utmSource: 'claude_ai' }, 'ai'],
      [{ utmMedium: 'claude.ai' }, 'ai'],
      [{ utmSource: 'perplexity' }, 'ai'],
      [{ referrerDomain: 'chatgpt.com', utmSource: 'chatgpt.com' }, 'ai'],
      [{ referrerDomain: 'gemini.google.com' }, 'ai'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })

  it('keeps a real referrer even when the tag names an assistant', () => {
    // The click happened on reddit.com; the tag says where the link was minted.
    expect(classifyChannel(row({ referrerDomain: 'reddit.com', utmSource: 'chatgpt.com' }))).toBe(
      'social',
    )
  })

  it('does not take a lookalike host', () => {
    expect(classifyChannel(row({ referrerDomain: 'notchatgpt.com' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'google.com' }))).toBe('organic_search')
  })
})

describe('organic search', () => {
  it.each(
    cases([
      [{ referrerDomain: 'google.com' }, 'organic_search'],
      [{ referrerDomain: 'google.de' }, 'organic_search'],
      [{ referrerDomain: 'google.co.uk' }, 'organic_search'],
      [{ referrerDomain: 'google.com.tr' }, 'organic_search'],
      [{ referrerDomain: 'bing.com' }, 'organic_search'],
      [{ referrerDomain: 'cn.bing.com' }, 'organic_search'],
      [{ referrerDomain: 'duckduckgo.com' }, 'organic_search'],
      [{ referrerDomain: 'search.yahoo.com' }, 'organic_search'],
      [{ referrerDomain: 'yandex.ru' }, 'organic_search'],
      [{ referrerDomain: 'baidu.com' }, 'organic_search'],
      [{ referrerDomain: 'ecosia.org' }, 'organic_search'],
      [{ referrerDomain: 'search.brave.com' }, 'organic_search'],
      [{ referrerDomain: 'kagi.com' }, 'organic_search'],
      [{ referrerDomain: 'GOOGLE.COM' }, 'organic_search'],
      [{ referrerDomain: 'www.google.com' }, 'organic_search'],
      // A tag with no referrer that names an engine.
      [{ utmSource: 'google' }, 'organic_search'],
      [{ utmSource: 'bing.com' }, 'organic_search'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })

  it('does not take every Google property for the search engine', () => {
    expect(classifyChannel(row({ referrerDomain: 'docs.google.com' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'sites.google.com' }))).toBe('referral')
    // Google's own non-search sites on generic TLDs.
    expect(classifyChannel(row({ referrerDomain: 'google.org' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'google.dev' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'google.net' }))).toBe('referral')
  })

  it('does not take a search company’s community or news sites for search', () => {
    expect(classifyChannel(row({ referrerDomain: 'blog.naver.com' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'cafe.naver.com' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'tieba.baidu.com' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'news.yahoo.co.jp' }))).toBe('referral')
    expect(classifyChannel(row({ referrerDomain: 'news.yahoo.com' }))).toBe('referral')
    // …while the engines themselves still are.
    expect(classifyChannel(row({ referrerDomain: 'search.naver.com' }))).toBe('organic_search')
    expect(classifyChannel(row({ referrerDomain: 'm.baidu.com' }))).toBe('organic_search')
    expect(classifyChannel(row({ referrerDomain: 'search.yahoo.co.jp' }))).toBe('organic_search')
  })

  it('takes utm_medium=organic as organic search', () => {
    expect(classifyChannel(row({ utmMedium: 'organic' }))).toBe('organic_search')
    expect(classifyChannel(row({ utmSource: 'launch', utmMedium: 'Organic' }))).toBe(
      'organic_search',
    )
    expect(classifyChannel(row({ referrerDomain: 'lobste.rs', utmMedium: 'organic' }))).toBe(
      'organic_search',
    )
  })
})

describe('social', () => {
  it.each(
    cases([
      [{ referrerDomain: 'facebook.com' }, 'social'],
      [{ referrerDomain: 'l.facebook.com' }, 'social'],
      [{ referrerDomain: 'm.facebook.com' }, 'social'],
      [{ referrerDomain: 'instagram.com' }, 'social'],
      [{ referrerDomain: 'x.com' }, 'social'],
      [{ referrerDomain: 't.co' }, 'social'],
      [{ referrerDomain: 'twitter.com' }, 'social'],
      [{ referrerDomain: 'linkedin.com' }, 'social'],
      [{ referrerDomain: 'lnkd.in' }, 'social'],
      [{ referrerDomain: 'old.reddit.com' }, 'social'],
      [{ referrerDomain: 'youtube.com' }, 'social'],
      [{ referrerDomain: 'youtu.be' }, 'social'],
      [{ referrerDomain: 'tiktok.com' }, 'social'],
      [{ referrerDomain: 'bsky.app' }, 'social'],
      [{ referrerDomain: 'threads.net' }, 'social'],
      [{ referrerDomain: 'news.ycombinator.com' }, 'social'],
      [{ referrerDomain: 'mastodon.social' }, 'social'],
      // Tags with no referrer: a host, a bare label a person types, a medium.
      [{ utmSource: 'twitter' }, 'social'],
      [{ utmSource: 'LinkedIn' }, 'social'],
      [{ utmSource: 'facebook.com' }, 'social'],
      [{ utmMedium: 'social' }, 'social'],
      [{ utmSource: 'launch', utmMedium: 'Social-Media' }, 'social'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })
})

describe('referral and direct', () => {
  it.each(
    cases([
      [{ referrerDomain: 'lobste.rs' }, 'referral'],
      [{ referrerDomain: 'producthunt.com' }, 'referral'],
      [{ referrerDomain: 'github.com' }, 'referral'],
      // A `ref` label no host is known for is stored as the label itself.
      [{ referrerDomain: 'bharathunt' }, 'referral'],
      // Tagged with no referrer and matching no rule: somebody sent it, the tag
      // says so, and it is not Direct.
      [{ utmSource: 'launch-week' }, 'referral'],
      [{ utmMedium: 'banner-swap' }, 'referral'],
      [{}, 'direct'],
      // `utm_campaign` alone is not read: a campaign names no sender and no
      // medium, so a campaign-only link with no referrer stays Direct (the
      // classifier's input has no campaign field on purpose).
      [{ referrerDomain: '   ', utmSource: ' ', utmMedium: '' }, 'direct'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })
})

describe('precedence', () => {
  it.each(
    cases([
      // paid > email
      [{ utmSource: 'mailchimp', utmMedium: 'cpc' }, 'paid'],
      [{ referrerDomain: 'mail.google.com', utmMedium: 'cpc' }, 'paid'],
      // paid > ai (a click id beats an assistant referrer)
      [{ referrerDomain: 'chatgpt.com', clickIdKey: 'gclid' }, 'paid'],
      // paid > organic search and > social
      [{ referrerDomain: 'google.com', clickIdKey: 'gclid' }, 'paid'],
      [{ referrerDomain: 'facebook.com', clickIdKey: 'fbclid' }, 'paid'],
      [{ referrerDomain: 'facebook.com', utmMedium: 'paid_social' }, 'paid'],
      // email > affiliate
      [{ utmSource: 'mailchimp', utmMedium: 'partner' }, 'email'],
      // email > ai
      [{ referrerDomain: 'chatgpt.com', utmMedium: 'newsletter' }, 'email'],
      // email > search (webmail is not search, even under google.com)
      [{ referrerDomain: 'mail.google.com' }, 'email'],
      // affiliate > ai and > search
      [{ referrerDomain: 'perplexity.ai', utmMedium: 'affiliate' }, 'affiliate'],
      [{ referrerDomain: 'google.com', utmMedium: 'affiliate' }, 'affiliate'],
      // ai > search (an assistant on a search engine's domain)
      [{ referrerDomain: 'gemini.google.com' }, 'ai'],
      [{ referrerDomain: 'copilot.microsoft.com' }, 'ai'],
      // search > social: the medium rule for social does not outrank a search referrer
      [{ referrerDomain: 'google.com', utmMedium: 'social' }, 'organic_search'],
      // social > referral
      [{ referrerDomain: 'reddit.com', utmSource: 'launch-week' }, 'social'],
    ]),
  )('%s', (_label, input, channel) => {
    expect(classifyChannel(row(input))).toBe(channel)
  })
})
