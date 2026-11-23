import { CLICK_ID_SOURCES } from './click-id.ts'
import { REF_SOURCE_ALIASES } from './ref-source.ts'
import { canonicalReferrerHost } from './referrer.ts'

/**
 * The channel a visit arrived through: one answer per sources tuple, and the
 * only definition of it.
 *
 * The Sources card's Channels cut, the `channel` field on every sources row of
 * `/v1/sites/{id}/analytics/sources`, `/v1/read/analytics/sources`, the public
 * share and the MCP `top_sources` tool, and the AI referrals card's choice of
 * rows all read this function's answer, computed on the server. The dashboard
 * never classifies a row itself: it folds the `channel` the row arrives with.
 *
 * ## What it reads, and what it cannot
 *
 * The inputs are the sources rollup's own dimensions — referrer host, utm
 * source and utm medium — because that is what the report reads (ClickHouse
 * 0008/0025) and channels are computed from it at read time, never stored.
 *
 * The rollup does NOT carry the click id. A visit that arrived with a `gclid`
 * and no referrer is stored with `referrer_domain = google.com` (ADR-0075 D-C1,
 * migration 0023) and nothing in `sources_15m`/`sources_1d` says that host was
 * inferred from an ad click. So on the sources report an untagged Google Ads
 * click reads as Organic search and an untagged Meta ad click as Social. A
 * visit is Paid there only when its link carries a paid `utm_medium`. The
 * `clickIdKey` input exists for readers that do have the key (`events_raw.
 * click_id_source`) and is pinned by the tests, so the rule is written once.
 *
 * ## Precedence
 *
 * A tuple usually matches more than one rule — a newsletter link to a page
 * ChatGPT also cites, a paid campaign that lands from facebook.com — so the
 * rules are tried in the order of `CHANNELS` and the first match wins:
 *
 * 1. **Paid**: an ad click id, or a paid `utm_medium`.
 * 2. **Email**: an email `utm_medium`, a `utm_source` naming a mail tool, a
 *    `utm_source` of `email` or `newsletter` with no medium, or a webmail
 *    referrer.
 * 3. **Affiliate**: an affiliate or partner `utm_medium`.
 * 4. **AI**: an assistant referrer, or with no referrer a tag naming one.
 * 5. **Organic search**: a search-engine referrer, `utm_medium=organic`, or
 *    with no referrer a tag naming an engine.
 * 6. **Social**: a social referrer, a social `utm_medium`, or with no referrer
 *    a tag naming a social network.
 * 7. **Referral**: any other referrer, or a `utm_source`/`utm_medium` naming
 *    anything at all — a tagged link was sent by somebody, so it is not Direct.
 * 8. **Direct**: no referrer and neither `utm_source` nor `utm_medium`.
 *
 * `utm_campaign` is not an input. A link tagged with a campaign and nothing
 * else names no sender and no medium, so with no referrer it is Direct: the
 * campaign says which push a visit belongs to, not where it came from, and the
 * Campaigns cut is where it is read.
 *
 * Every utm comparison is case-insensitive and treats `-`, `_` and spaces as
 * one separator, because the same medium arrives as `paid_social`,
 * `Paid-Social` and `paid social` depending on who built the link.
 */

export const CHANNELS = [
  'paid',
  'email',
  'affiliate',
  'ai',
  'organic_search',
  'social',
  'referral',
  'direct',
] as const

export type Channel = (typeof CHANNELS)[number]

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
}

/** One sources tuple, as the classifier reads it. */
export interface ChannelInput {
  /** The stored `referrer_domain`; `''` for none. */
  readonly referrerDomain: string
  readonly utmSource: string
  readonly utmMedium: string
  /**
   * The click-id key that produced an inferred referrer (`gclid`, `fbclid`, …),
   * when the reader has it. The sources rollup does not; see the module header.
   */
  readonly clickIdKey?: string | null
}

// ---------------------------------------------------------------------------
// The lists. Hosts are written in `canonicalReferrerHost` form and match the
// host itself or any subdomain of it, unless a list says otherwise.
// ---------------------------------------------------------------------------

/**
 * The AI assistants: chat and answer products whose links out are clicks on an
 * answer rather than on a search result or a post. The AI referrals card is
 * the rows this list classifies as `ai`.
 */
export const AI_ASSISTANT_HOSTS: readonly string[] = Object.freeze([
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'perplexity.ai',
  'gemini.google.com',
  'notebooklm.google.com',
  'copilot.microsoft.com',
  'grok.com',
  'chat.deepseek.com',
  'chat.mistral.ai',
  'chat.qwen.ai',
  'meta.ai',
  'you.com',
  'poe.com',
  'phind.com',
  'kimi.com',
  'duck.ai',
])

/**
 * The bare names an assistant writes into a link's utm tag, keyed with
 * everything but letters and digits removed, so `Claude AI`, `claude_ai` and
 * `ClaudeAI` are one key. ChatGPT tags `utm_source=chatgpt.com`; Claude tags
 * `utm_source=Claude AI` with `utm_medium=claude.ai` (seen 2026-09-10). A
 * host-shaped value is matched against `AI_ASSISTANT_HOSTS` instead.
 */
export const AI_ASSISTANT_TAGS: readonly string[] = Object.freeze([
  'chatgpt',
  'openai',
  'claude',
  'claudeai',
  'anthropic',
  'perplexity',
  'perplexityai',
  'gemini',
  'googlegemini',
  'copilot',
  'microsoftcopilot',
  'grok',
  'deepseek',
  'mistral',
  'lechat',
  'metaai',
])

/**
 * Search engines, matched with their subdomains (`cn.bing.com`, `m.baidu.com`)
 * except those in `NOT_SEARCH_HOSTS`. Google is matched by pattern instead
 * (every country property, apex only), because `docs.google.com` and
 * `sites.google.com` are not search.
 */
export const SEARCH_ENGINE_HOSTS: readonly string[] = Object.freeze([
  'bing.com',
  'duckduckgo.com',
  'search.yahoo.com',
  'yahoo.co.jp',
  'yandex.ru',
  'yandex.com',
  'baidu.com',
  'ecosia.org',
  'search.brave.com',
  'startpage.com',
  'qwant.com',
  'kagi.com',
  'mojeek.com',
  'naver.com',
  'seznam.cz',
  'sogou.com',
  'ask.com',
  'search.aol.com',
])

/**
 * The parts of a search company that are not its search engine: blogs,
 * forums, news and mail on the engine's own domain. Matched with subdomains.
 */
const NOT_SEARCH_HOSTS: readonly string[] = Object.freeze([
  'blog.naver.com',
  'cafe.naver.com',
  'tieba.baidu.com',
  'news.yahoo.co.jp',
  'mail.yahoo.co.jp',
  'news.yahoo.com',
  'mail.yahoo.com',
])

/**
 * Google's search properties, apex only: `google.com`, a two-letter country
 * domain (`google.de`), or one under `co.`/`com.` (`google.co.uk`,
 * `google.com.tr`). Generic TLDs are not search: `google.org` is the charity,
 * `google.dev` the developer site.
 */
const GOOGLE_SEARCH = /^google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/

/** Bare utm values a person writes for a search engine. */
const SEARCH_ENGINE_TAGS: readonly string[] = Object.freeze([
  'google',
  'bing',
  'duckduckgo',
  'yahoo',
  'yandex',
  'baidu',
  'ecosia',
  'brave',
  'kagi',
])

/** Social networks and community sites. */
export const SOCIAL_HOSTS: readonly string[] = Object.freeze([
  'facebook.com',
  'fb.com',
  'messenger.com',
  'instagram.com',
  'threads.net',
  'threads.com',
  'x.com',
  'twitter.com',
  't.co',
  'linkedin.com',
  'lnkd.in',
  'reddit.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'pinterest.com',
  'pin.it',
  'snapchat.com',
  'tumblr.com',
  'bsky.app',
  'mastodon.social',
  'news.ycombinator.com',
  'quora.com',
  'discord.com',
  'discord.gg',
  'telegram.org',
  't.me',
  'whatsapp.com',
  'wa.me',
  'vk.com',
  'weibo.com',
  'twitch.tv',
])

/** Webmail clients: a click inside a mail opened in the browser. */
export const WEBMAIL_HOSTS: readonly string[] = Object.freeze([
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'mail.protonmail.com',
  'mail.aol.com',
  'mail.zoho.com',
  'mail.zoho.eu',
  'app.fastmail.com',
  'mail.yandex.ru',
  'mail.yandex.com',
  'e.mail.ru',
  'mail.gmx.net',
  'navigator.gmx.net',
  'navigator.web.de',
  'mail.yahoo.co.jp',
])

/** Newsletter and email tools whose name a link's `utm_source` carries. */
export const EMAIL_TOOL_TAGS: readonly string[] = Object.freeze([
  'mailchimp',
  'convertkit',
  'beehiiv',
  'buttondown',
  'substack',
  'mailerlite',
  'klaviyo',
  'brevo',
  'sendinblue',
  'sendgrid',
  'campaignmonitor',
  'constantcontact',
  'activecampaign',
  'customerio',
  'mailjet',
  'loops',
  'resend',
  'postmark',
  'emailoctopus',
  'omnisend',
  'drip',
])

const PAID_MEDIUMS = new Set([
  'cpc',
  'ppc',
  'paid',
  'paidsearch',
  'paid_search',
  'paidsocial',
  'paid_social',
  'paid_media',
  'display',
  'banner',
  'cpm',
  'ads',
])
const EMAIL_MEDIUMS = new Set(['email', 'newsletter'])
/** A `utm_source` that names the kind of message rather than the tool. */
const EMAIL_SOURCES = new Set(['email', 'newsletter'])
const ORGANIC_MEDIUM = 'organic'
const AFFILIATE_MEDIUMS = new Set(['affiliate', 'affiliates', 'partner', 'partners'])
const SOCIAL_MEDIUMS = new Set(['social', 'social_media', 'social_network'])

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** `Paid-Social ` → `paid_social`. */
function mediumKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/** `Claude AI` → `claudeai`. */
function tagKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function hostIn(host: string, list: readonly string[]): boolean {
  if (host === '') return false
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

/** A host-shaped tag value, canonical, or `''` when the value is a bare word. */
function hostOfTag(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed.includes('.')) return ''
  const withoutScheme = trimmed.replace(/^[a-z+]+:\/\//, '').replace(/[/?#].*$/, '')
  return canonicalReferrerHost(withoutScheme)
}

/**
 * Public suffixes of two labels that a tool's domain sits under. Not the
 * public-suffix list: the handful a `utm_source` is seen with.
 */
const SECOND_LEVEL_SUFFIXES: readonly string[] = Object.freeze([
  'co.uk',
  'com.au',
  'co.jp',
  'com.br',
  'co.in',
  'co.nz',
  'co.za',
  'com.mx',
])

/**
 * The registrable label of a host-shaped tag: `buttondown.email` →
 * `buttondown`, `mailchimp.co.uk` → `mailchimp`.
 */
function labelOfTagHost(host: string): string {
  const labels = host.split('.')
  const suffixLength = SECOND_LEVEL_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`)) ? 2 : 1
  const index = labels.length - suffixLength - 1
  return index >= 0 ? (labels[index] as string) : host
}

/** The host a bare tag a person types stands for (`twitter` → `x.com`). */
function aliasHost(value: string): string {
  const key = value.trim().toLowerCase()
  return Object.hasOwn(REF_SOURCE_ALIASES, key) ? (REF_SOURCE_ALIASES[key] as string) : ''
}

function isSearchHost(host: string): boolean {
  if (GOOGLE_SEARCH.test(host)) return true
  return hostIn(host, SEARCH_ENGINE_HOSTS) && !hostIn(host, NOT_SEARCH_HOSTS)
}

/** Whether a utm value names an assistant: a bare name or an assistant host. */
function tagNamesAi(value: string): boolean {
  if (value.trim() === '') return false
  const host = hostOfTag(value)
  if (host !== '') return hostIn(host, AI_ASSISTANT_HOSTS)
  return AI_ASSISTANT_TAGS.includes(tagKey(value))
}

function tagNamesEmailTool(value: string): boolean {
  if (value.trim() === '') return false
  const host = hostOfTag(value)
  const key = host !== '' ? labelOfTagHost(host) : tagKey(value)
  return EMAIL_TOOL_TAGS.includes(key)
}

function tagNamesSearch(value: string): boolean {
  if (value.trim() === '') return false
  const host = hostOfTag(value) || aliasHost(value)
  if (host !== '') return isSearchHost(host)
  return SEARCH_ENGINE_TAGS.includes(tagKey(value))
}

function tagNamesSocial(value: string): boolean {
  if (value.trim() === '') return false
  const host = hostOfTag(value) || aliasHost(value)
  return hostIn(host, SOCIAL_HOSTS)
}

function isClickIdKey(key: string | null | undefined): boolean {
  if (key === null || key === undefined) return false
  const normalized = key.trim().toLowerCase()
  return normalized !== '' && Object.hasOwn(CLICK_ID_SOURCES, normalized)
}

/**
 * The channel of one sources tuple. Pure, total and deterministic: every input
 * has exactly one answer, and the same input always gets the same one.
 */
export function classifyChannel(input: ChannelInput): Channel {
  const host = canonicalReferrerHost(input.referrerDomain)
  const source = input.utmSource.trim()
  const medium = mediumKey(input.utmMedium)
  const tagged = source !== '' || medium !== ''

  if (isClickIdKey(input.clickIdKey) || PAID_MEDIUMS.has(medium)) return 'paid'

  if (
    EMAIL_MEDIUMS.has(medium) ||
    tagNamesEmailTool(source) ||
    (medium === '' && EMAIL_SOURCES.has(mediumKey(source))) ||
    hostIn(host, WEBMAIL_HOSTS)
  ) {
    return 'email'
  }

  if (AFFILIATE_MEDIUMS.has(medium)) return 'affiliate'

  // A referrer the browser sent is where the click happened, so it decides
  // AI, search and social on its own; a tag stands in only when there is none.
  if (host !== '') {
    if (hostIn(host, AI_ASSISTANT_HOSTS)) return 'ai'
    if (isSearchHost(host) || medium === ORGANIC_MEDIUM) return 'organic_search'
    if (hostIn(host, SOCIAL_HOSTS) || SOCIAL_MEDIUMS.has(medium)) return 'social'
    return 'referral'
  }

  if (tagNamesAi(source) || tagNamesAi(input.utmMedium)) return 'ai'
  if (tagNamesSearch(source) || medium === ORGANIC_MEDIUM) return 'organic_search'
  if (tagNamesSocial(source) || SOCIAL_MEDIUMS.has(medium)) return 'social'
  return tagged ? 'referral' : 'direct'
}
