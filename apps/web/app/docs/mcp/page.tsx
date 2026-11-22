import {
  Code,
  DocArticle,
  DocCode,
  DocLink,
  DocList,
  DocNote,
  DocSection,
} from "@/components/docs/doc-prose";
import { API_BASE_URL } from "@/lib/api";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("mcp");
export const metadata = docsMetadata(page);

export default function McpDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="What MCP gives you">
        <p>
          The Model Context Protocol is how AI agents (Claude, ChatGPT, and
          anything MCP-speaking) get tools. Connect Open Analytics and your
          agent can read your traffic, list your sites, and, where you
          granted it, manage funnels, event definitions, widgets, sharing
          and the notes on your chart, all in plain conversation.
        </p>
      </DocSection>

      <DocSection title="Connecting">
        <p>Point your MCP client at the server:</p>
        <DocCode caption="MCP endpoint">{`${API_BASE_URL}/mcp`}</DocCode>
        <p>
          The client registers itself and sends you through an OAuth consent
          in the browser: you see the app&apos;s name and exactly which
          scopes it asks for, and you approve or deny. No API key ever
          changes hands. In Claude, add it as a custom connector with that
          URL; other clients take the URL in their MCP settings.
        </p>
      </DocSection>

      <DocSection title="Scopes: what an agent can and cannot do">
        <DocList
          items={[
            <span key="read">
              Read scopes cover sites, analytics, realtime and revenue
              aggregates: <Code>site:read analytics:read realtime:read
              revenue:read</Code>, plus <Code>team:read</Code> and{" "}
              <Code>billing:read</Code> where asked.
            </span>,
            <span key="write">
              Write scopes are granular and opt-in per grant:{" "}
              <Code>sites:write funnels:write events:write widgets:write
              share:write notes:write</Code>. An agent granted funnels cannot
              touch sharing. With <Code>notes:write</Code> an agent can add,
              edit and delete notes on your chart; your MCP client asks you
              before it deletes one.
            </span>,
            "Some things are never writable by any agent, by design: deleting a site, team membership, API keys, billing and domains stay human-only.",
          ]}
        />
      </DocSection>

      <DocSection title="Revoking">
        <DocNote>
          Every connected app is listed under Account, Connected apps, with
          its scopes; revoking cuts its access immediately. Connections and
          first-use-from-a-new-source events are journalled, so you can
          always answer who could read this account. For questions inside
          the dashboard itself, there is also{" "}
          <DocLink slug="assistant">the built-in assistant</DocLink>, which
          needs no setup.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
