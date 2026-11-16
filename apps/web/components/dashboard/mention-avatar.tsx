"use client";

import * as React from "react";
import { API_BASE_URL, LIVE_API } from "@/lib/api-config";
import type { Mention } from "@/lib/api";
import { mentionAvatarSrc } from "@/lib/mention-avatar";
import { initialsOf } from "@/lib/mentions";
import { cn } from "@/lib/utils";

/**
 * A mention author's face: the picture our API stored for them, or their
 * initials when there is none or it fails to load.
 *
 * **Nothing here loads from X.** `avatar_url` is a path on our own API, and
 * `mentionAvatarSrc` refuses anything that is not (an X address included), so
 * a viewer's browser never sends X a request.
 *
 * **How the picture authenticates.** The route takes the session cookie. The
 * dashboard and the API are separate hosts on one site (`app.` and `api.`),
 * and the cookie is `SameSite=Lax`, host-only on the API: a plain `<img>`
 * request to a same-site host carries it, so no `crossOrigin` (which would ask
 * the image route for CORS headers it does not need) and no fetch-and-blob. A
 * deployment where the cookie does not reach the image gets a `401`, which is
 * a load error, which is the initials.
 *
 * `alt=""`: the author's name is always written beside it.
 */

export type MentionAvatarSize = 16 | 20 | 24 | 32;

const INITIALS_TEXT: Record<MentionAvatarSize, string> = {
  16: "text-[7px]",
  20: "text-[8px]",
  24: "text-[10px]",
  32: "text-xs",
};

export function MentionAvatar({
  author,
  size,
  tone = "light",
  className,
}: {
  author: Pick<Mention["author"], "handle" | "name" | "avatar_url">;
  size: MentionAvatarSize;
  /** `dark` for the chart tooltip's dark surface. */
  tone?: "light" | "dark";
  className?: string;
}) {
  const src = mentionAvatarSrc(author.avatar_url, {
    apiBase: API_BASE_URL,
    allowDataUrls: !LIVE_API,
  });
  // Keyed on the address, so a new picture for the same row gets its own try.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showPicture = src !== null && failedSrc !== src;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium",
        tone === "dark"
          ? "bg-white/15 text-chart-tooltip-foreground/80"
          : "bg-black/6 text-foreground/70",
        INITIALS_TEXT[size],
        className
      )}
      style={{ width: size, height: size }}
    >
      {showPicture ? (
        // A plain <img>: the bytes are ours, already small, and must carry the
        // session cookie, none of which next/image's optimiser would help.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          className="size-full object-cover"
          decoding="async"
          draggable={false}
          height={size}
          loading="lazy"
          onError={() => setFailedSrc(src)}
          referrerPolicy="no-referrer"
          src={src}
          width={size}
        />
      ) : (
        initialsOf(author.name, author.handle)
      )}
    </span>
  );
}
