import {
  Code,
  DocArticle,
  DocCode,
  DocHeading,
  DocLink,
  DocList,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("dashboard");
export const metadata = docsMetadata(page);

export default function DashboardDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="How the overview reads">
        <p>
          A site&apos;s overview reads top to bottom. The headline totals come
          first (visitors, pageviews, bounce rate, average visit), then the
          traffic chart, then the breakdowns: pages, sources, geography,
          devices and custom events. Every number answers the range picked in
          the header, and every breakdown is that same range cut a different
          way, so nothing on the page is measuring a different window than
          anything else.
        </p>
      </DocSection>

      <DocSection title="The headline numbers">
        <DocTable
          head={["Metric", "What it counts"]}
          rows={[
            [
              "Visitors",
              "Unique people in the range, counted with the daily-rotating identifier. Never summed from days, so a 30-day count is not the sum of 30 daily counts.",
            ],
            ["Pageviews", "Every page load and client-side route change."],
            [
              "Bounce rate",
              "The share of sessions with a single interaction, rebuilt server-side from the 30-minute session rule.",
            ],
            [
              "Average visit",
              "Mean session duration, from engagement time rather than raw tab-open time.",
            ],
          ]}
        />
      </DocSection>

      <DocSection title="The breakdowns">
        <p>
          Every row has a bar behind it, as long as the row&apos;s number
          against the biggest row in the list. The percentage beside it is the
          row&apos;s share of all the rows, so the first bar is always full and
          its percentage usually is not.
        </p>
        <DocHeading>Pages</DocHeading>
        <p>
          Top paths by pageviews, with entries and exits, so you can see where
          people land and where they leave. The column you rank by is a
          question put to the server, not a re-sort of the rows on screen: a
          top-100-by-views page re-sorted by exits would present that
          page&apos;s biggest exits as the site&apos;s biggest.
        </p>
        <DocHeading>Sources</DocHeading>
        <p>
          Where visits come from, canonicalised: your own domain is dropped as
          a referrer, and hosts are folded to a channel name with a favicon, so
          Google&apos;s many subdomains read as one Google. Visits that arrive
          with no referrer at all read as Direct &mdash; tagging your links
          (just below) is how you give those a name. See{" "}
          <DocLink slug="troubleshooting">troubleshooting</DocLink> if a number
          looks lower than another tool&apos;s.
        </p>
        <p>
          The Channels cut groups the same visits by how they arrived, and the
          first rule that matches decides: Paid (a paid{" "}
          <Code>utm_medium</Code> such as <Code>cpc</Code>), Email (an email
          or newsletter tag, a newsletter tool as <Code>utm_source</Code>, or
          a webmail referrer), Affiliate (<Code>utm_medium=affiliate</Code> or{" "}
          <Code>partner</Code>), AI (the assistants in the AI referrals card),
          Organic search (a search engine, or{" "}
          <Code>utm_medium=organic</Code>), Social, Referral (any other site,
          or a source or medium tag no rule names) and Direct (no referrer and
          no source or medium tag; a link tagged with only{" "}
          <Code>utm_campaign</Code> stays Direct). An ad click that carries
          only the platform&apos;s click id, with no utm tag, is counted under
          the platform&apos;s site, so it reads as Organic search or Social
          rather than Paid; tag your ad links with a paid{" "}
          <Code>utm_medium</Code> to see them as Paid. Channels show no
          revenue.
        </p>
        <p>
          In the Referrers list under See all, a row whose site sent visits
          from a particular page opens to show those pages, such as a
          Lobsters story or a GitHub README. Most sites send only their
          address and no page, so most rows have nothing to open. Pages are
          shown without their query string, and a part of the address that
          looks like a token or an email address is shown as{" "}
          <Code>[redacted]</Code>, because those links can carry one. Pages
          are available for ranges up to 92 days.
        </p>
        <p>
          If you own the site and a payment provider is connected, the Sources
          card and the Entry pages cut of the Pages card also show revenue: a
          green part on each row&apos;s bar and the amount beside its number,
          with a toggle in the header to rank the rows by revenue instead. The
          revenue, renewals included, goes to the source or entry page of the
          buyer&apos;s last visit before the purchase. Hover or focus a row for
          its revenue and buyers and, for ranges up to 92 days, the visitors
          whose visit started there and the revenue per visitor. Orders in a
          currency with no exchange rate are left out, and the row says how
          many. Revenue is hidden while a filter is on, because revenue cannot
          be filtered, and for ranges over 400 days. See{" "}
          <DocLink slug="revenue">revenue</DocLink>.
        </p>
        <DocHeading>AI referrals</DocHeading>
        <p>
          The visits AI assistants sent: ChatGPT, Claude, Perplexity, Gemini
          and the rest, one row each, with the total and its share of all
          visitors on top. A visit counts when the assistant is its referrer,
          or, when it arrived with no referrer at all, when the utm tag the
          assistant added names it: ChatGPT writes{" "}
          <Code>utm_source=chatgpt.com</Code> and Claude writes{" "}
          <Code>utm_source=Claude AI</Code>, and a click from their apps
          carries the tag with no referrer, so it is counted here rather than
          filed under Direct. Each visit counts once, and it is the same set
          the Channels cut counts as AI: a visit whose link also carries a
          paid, email or affiliate tag is counted there instead. A referral is a click; being cited
          inside an answer without a click leaves no trace here, so a small
          number does not mean you are absent from AI answers. Clicks out of
          Google AI Overviews arrive as <Code>google.com</Code> and cannot be
          separated from search.
        </p>
        <DocHeading>Geography and technology</DocHeading>
        <p>
          Country-level geography from a privacy-preserving lookup, and one
          technology card that cuts the same visits by browser, operating
          system or device type, picked in its header, each over the same
          range.
        </p>
        <DocHeading>Custom events</DocHeading>
        <p>
          The events you defined, with counts, when they last fired and a
          sample of their properties. See{" "}
          <DocLink slug="custom-events">custom events</DocLink> to add them.
        </p>
        <DocHeading>Filtering by a row</DocHeading>
        <p>
          Clicking a row in Sources, Locations or the device cards keeps only
          the sessions that match it, and the rest of the overview re-reads
          with that filter applied. There is no separate filter picker: the row
          is the door, which is why its name underlines under the pointer. What
          you have picked appears as marks on the bar at the bottom of the
          screen &mdash; a favicon, a flag, a device glyph &mdash; and each
          mark clears on its own.
        </p>
        <DocList
          items={[
            "A filter selects sessions, and the report then describes everything those sessions did. Keeping the visits from Google shows every page they went on to read, not only the page they landed on.",
            "Two picks in one breakdown mean either (Google or GitHub); picks in two breakdowns mean both (Google and mobile).",
            "The four things you can filter by are all about the visit rather than the page: source, country, city and device. Pages are deliberately not one of them, because “filter by page” would have to choose between the sessions that touched a page and the pageviews of it, and those are different questions.",
            "Custom events and performance answer the range but not the filter, and leave the marks alone rather than pretending to narrow.",
          ]}
        />
        <DocNote>
          A filtered view is rebuilt from raw events rather than read off a
          rollup, so it covers at most 92 days where the unfiltered report
          answers a year. Past that the cards say so and offer the two ways
          out: shorten the range, or drop the filters and keep it.
        </DocNote>
      </DocSection>

      <DocSection title="Tag your own links">
        <p>
          Browsers send less and less referrer information every year, and
          some places send none at all &mdash; a link in a newsletter, a PDF,
          a chat app or an app&apos;s in-built browser usually arrives with
          nothing attached, which is why so much traffic reads as Direct.
          Adding a <Code>ref</Code> to the link fixes that, and there is
          nothing to turn on: if a visit arrives with no referrer of its own,
          the tag names the source.
        </p>
        <DocCode caption="Any link you control">{`https://example.com/?ref=twitter
https://example.com/pricing?ref=newsletter`}</DocCode>
        <DocList
          items={[
            "Known names are folded onto the site they mean, so ?ref=twitter lands in the same row as the visits X reports itself. A domain works too: ?ref=selfh.st.",
            "Anything else is kept exactly as you wrote it, so ?ref=newsletter is its own row in Sources — useful for the places that have no domain at all.",
            "A referrer the browser did send always wins. The tag only fills in what would otherwise be Direct, so a leftover ?ref on your own internal links cannot invent a visit.",
          ]}
        />
        <DocNote>
          Many sites already do this for you: Product Hunt appends{" "}
          <Code>?ref=producthunt</Code> to every outbound link, and so do most
          launch boards, directories and newsletters &mdash; those visits stop
          reading as Direct on their own. <Code>ref</Code> and UTM tags answer
          different questions and do not compete: <Code>utm_source</Code> and
          its companions are their own cuts of the Sources card, for campaigns
          you are running and measuring, while <Code>ref</Code> is a light way
          to name where a single link lives. A link may carry both. Tagging is
          only read going forward &mdash; it cannot relabel visits that already
          happened.
        </DocNote>
      </DocSection>

      <DocSection title="Ranges and comparisons">
        <DocList
          items={[
            "The interval picker covers today, yesterday, the last 7 and 30 days, month and year views, 6 and 12 months, and All time (anchored at your site's first event).",
            "Comparisons show the preceding equal-length period beside the current one, so a delta is always against something concrete.",
            "The chart picks its own grain honestly: hours for a day, days for a month, ISO weeks for 6 and 12 months. Weekly unique visitors are merged server-side, never summed from days, so uniques stay true.",
          ]}
        />
      </DocSection>

      <DocSection title="Whose clock cuts the day">
        <p>
          Charts follow the site&apos;s reporting timezone, so Today means
          the same day for everyone on the team. To read the numbers on your
          own clock, switch the timezone from the dashboard header; it changes
          your view only. The{" "}
          <DocLink slug="timezones">timezones page</DocLink> has the details.
        </p>
      </DocSection>

      <DocSection title="Sessions and engagement">
        <p>
          A session is rebuilt server-side with a 30-minute inactivity rule;
          bounce rate and average visit duration come from it. Engagement
          time is measured with two clocks (visible time, and active time
          near a real interaction), so a tab parked in the background does
          not inflate anything.
        </p>
      </DocSection>

      <DocSection title="Freshness">
        <DocNote>
          Events typically land in charts within seconds. When the chip
          beside a card&apos;s title says Catching up, the pipeline is behind
          and the charts are honest about it; a site with no traffic simply
          shows its last visit&apos;s age. For the current moment, the{" "}
          <DocLink slug="realtime">realtime view</DocLink> is the faster
          surface.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
