"use client";

import * as React from "react";
import { relativeTime } from "@/components/dashboard/data-state";
import { ExternalLinkIcon, LinkIcon } from "@/components/icons/hugeicons";
import { Badge } from "@/components/ui/badge";
import type { Mention } from "@/lib/api";
import {
  formatCompact,
  initialsOf,
  matchedTermLabel,
  mentionCounts,
} from "@/lib/mentions";

/**
 * One post that mentions the site.
 *
 * **Nothing here loads from X.** The author's avatar would be an image from
 * X's media host, and fetching it would send every dashboard viewer's IP
 * address to X. The initials disc stands in for it; the links only leave
 * when somebody clicks them.
 */

const absolute = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const LINK_PROPS = { rel: "noopener noreferrer", target: "_blank" } as const;

export function MentionRow({
  mention,
  domain,
}: {
  mention: Mention;
  domain: string;
}) {
  const { author } = mention;
  const counts = mentionCounts(mention);
  const term = matchedTermLabel(mention, domain);
  const posted = new Date(mention.posted_at);

  return (
    <li className="flex gap-3 py-3">
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 select-none items-center justify-center rounded-full bg-black/6 text-xs font-medium text-foreground/70"
      >
        {initialsOf(author.name, author.handle)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 select-none truncate text-sm">
            <a
              className="rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              href={author.url}
              {...LINK_PROPS}
            >
              {author.name ? (
                <>
                  {author.name}{" "}
                  <span className="font-normal text-muted-foreground">
                    @{author.handle}
                  </span>
                </>
              ) : (
                // No display name: the handle once, not twice.
                `@${author.handle}`
              )}
            </a>
            <span className="text-xs text-muted-foreground">
              {author.followers !== null
                ? ` · ${formatCompact(author.followers)} followers`
                : null}
              {" · "}
              <time dateTime={mention.posted_at} title={absolute.format(posted)}>
                {relativeTime(mention.posted_at) ?? absolute.format(posted)}
              </time>
            </span>
          </p>
          <a
            className="flex shrink-0 select-none items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            href={mention.url}
            {...LINK_PROPS}
          >
            Open on X
            <ExternalLinkIcon aria-hidden="true" className="size-3" />
          </a>
        </div>

        <p className="mt-1 line-clamp-4 whitespace-pre-line break-words text-sm leading-6 text-foreground/90">
          {mention.text}
        </p>

        {mention.links_to_site || term || counts.length > 0 ? (
          <div className="mt-1.5 flex select-none flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {mention.links_to_site ? (
              <Badge icon={<LinkIcon />} size="sm" variant="secondary">
                Links to your site
              </Badge>
            ) : null}
            {term ? <span>Matched &ldquo;{term}&rdquo;</span> : null}
            {counts.length > 0 ? (
              <span>
                {counts.map((count, index) => (
                  <React.Fragment key={count.key}>
                    {index > 0 ? " · " : null}
                    <span className="tabular-nums">
                      {formatCompact(count.value)}
                    </span>{" "}
                    {count.label}
                  </React.Fragment>
                ))}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
