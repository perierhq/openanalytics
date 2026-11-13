import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocList,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { API_BASE_URL } from "@/lib/api";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("api");
export const metadata = docsMetadata(page);

export default function ReadApiDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="Authentication">
        <p>
          The read surface lives under{" "}
          <Code>{`${API_BASE_URL}/v1/read/`}</Code> and takes a Bearer
          credential of either kind:
        </p>
        <DocList
          items={[
            <span key="key">
              A <DocLink slug="api-keys">read key</DocLink>, created per
              site in Settings, API. Shown once; treat it like a secret.
            </span>,
            <span key="oauth">
              An OAuth token, which is how{" "}
              <DocLink slug="cli">the CLI</DocLink> and{" "}
              <DocLink slug="mcp">MCP clients</DocLink> sign in. Tokens are
              scoped and revocable from Account, Connected apps.
            </span>,
          ]}
        />
        <p>
          Site-scoped calls name the site in an <Code>x-oa-site</Code>{" "}
          header. Leave the header off for calls that are not about one
          site; an empty value is refused rather than guessed.
        </p>
      </DocSection>

      <DocSection title="A first request">
        <DocCode caption="terminal">{`curl "${API_BASE_URL}/v1/read/analytics/overview?from=2026-08-01T00:00:00.000Z&to=2026-08-08T00:00:00.000Z&timezone=Europe/Istanbul" \\
  -H "authorization: Bearer YOUR_READ_KEY" \\
  -H "x-oa-site: YOUR_SITE_ID"`}</DocCode>
        <DocNote>
          Ranges are full ISO-8601 UTC instants; date-only strings are a
          400. <Code>timezone</Code> is an IANA name and decides how days
          are bucketed. Optional: <Code>compare=true</Code> for the
          preceding period, <Code>resolution</Code> (hour, day; the
          timeseries adds week) to pick the grain explicitly.
        </DocNote>
      </DocSection>

      <DocSection title="Endpoints">
        <DocTable
          head={["Path", "Answers"]}
          rows={[
            [<Code key="a">GET /v1/read/sites</Code>, "The sites this credential can see: id, slug, name, status, role."],
            [<Code key="b">GET /v1/read/site</Code>, "The selected site's metadata, including its tracking key and script URL for installs."],
            [<Code key="c">GET /v1/read/analytics/overview</Code>, "Totals for the range: events, pageviews, visitors."],
            [<Code key="d">GET /v1/read/analytics/timeseries</Code>, "The chart's series, at an honest grain; weekly uniques merged server-side."],
            [<Code key="e">GET /v1/read/analytics/pages</Code>, "Top pages."],
            [<Code key="f">GET /v1/read/analytics/sources</Code>, "Referrers and campaigns."],
            [<Code key="g">GET /v1/read/analytics/geography</Code>, "Countries and cities."],
            [<Code key="h">GET /v1/read/analytics/devices</Code>, "Device types, browsers, operating systems."],
            [<Code key="i">GET /v1/read/analytics/sessions</Code>, "Bounce rate and visit duration."],
            [<Code key="p">GET /v1/read/analytics/custom-events/properties</Code>, "One custom event's top values per property key, plus an other row. Person credentials only, never an API key."],
            [<Code key="j">GET /v1/read/revenue/…</Code>, "Revenue aggregates (summary, timeseries, attribution by source or entry page, events before purchase) and subscription MRR and churn (subscriptions/summary, subscriptions/timeseries), for the site owner."],
            [<Code key="k">POST /v1/read/realtime/token</Code>, "A short-lived token for the realtime stream (OAuth credentials only)."],
          ]}
        />
      </DocSection>

      <DocSection title="Errors and limits">
        <DocList
          items={[
            <span key="env">
              Errors arrive as{" "}
              <Code>{`{"error":{"code","message"}}`}</Code> with the obvious
              statuses; a 429 carries Retry-After.
            </span>,
            "Reads are rate- and cost-limited per credential, generously for dashboards and scripts, visibly for runaway loops.",
            "The realtime stream takes its token in the Authorization header; token-shaped query parameters are rejected by design.",
          ]}
        />
      </DocSection>
    </DocArticle>
  );
}
