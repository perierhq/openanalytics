import { z } from 'zod'

/**
 * Canonical error envelope and stable error code catalog.
 *
 * Docs snapshot 03 §6.1: the frontend branches on the stable `code`, never on
 * the free-form message. Adding a code is additive; renaming or removing one is
 * a breaking contract change and needs an OpenAPI major bump.
 */

export const ERROR_CODES = [
  // Authentication and authorization
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'REAUTH_REQUIRED',

  // Site state
  // An operator has suspended this site, so the surfaces that read its
  // analytics are closed until it is restored. Its own code rather than
  // `FORBIDDEN` because the caller's permissions are not the problem and
  // nothing they can do to their own membership will help: the recovery is a
  // state change on the site, and a client that branches on this shows the
  // site's own banner rather than an authorization error.
  'SITE_SUSPENDED',

  // Resource and request shape
  'SITE_NOT_FOUND',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'IDEMPOTENCY_CONFLICT',
  // The address already belongs to a member of this site. Split out of
  // IDEMPOTENCY_CONFLICT because the two 409s on the invite routes need
  // different words and different recovery: "an invite is already pending for
  // this address" (revoke or resend it) versus "this person is already on the
  // team" (nothing to do).
  'ALREADY_MEMBER',
  // The account cannot be deleted yet because sites still depend on this user
  // (ADR-0030, decision 8). Not a FORBIDDEN — the caller is allowed to delete
  // their account, the account is simply not in a deletable state — and not a
  // VALIDATION_FAILED, because nothing about the request is wrong. The remedy is
  // a sequence of other operations (hand the site over, or delete it), and
  // `details.blocking_sites` names each one and which of the two it needs.
  'ACCOUNT_DELETION_BLOCKED',
  // A site may hold exactly one non-terminal import run (ADR-0032, D3), so
  // starting a second one — or acting on a run that has moved past the state the
  // action needs — is a conflict with the site's current state, not a bad
  // request. Its own code because the recovery is specific and nameable: publish
  // or discard the run that is already there. `details.import_run_id` names it.
  'IMPORT_IN_PROGRESS',
  // `complete` was called and the object is not in the bucket. Distinct from
  // IMPORT_FAILED, which means the archive was there and could not be used: this
  // one says the upload itself never landed, and the recovery is to PUT again
  // through the signed URL rather than to fix the file.
  'IMPORT_UPLOAD_MISSING',
  // The run is the published one and its predecessor can no longer be restored:
  // cleanup keeps exactly ONE rollback generation (ADR-0032, D3), and this run's
  // is already erased. Deliberately not IMPORT_IN_PROGRESS, which says "the run
  // is not in a state that admits this" and would send a client looking at the
  // phase — the phase here is exactly right, and it is the *predecessor* that is
  // gone. There is no recovery: the honest client behaviour is to stop offering
  // the rollback, which needs a code it can branch on.
  'IMPORT_ROLLBACK_UNAVAILABLE',
  // A site may hold one live export at a time (ADR-0032, D8 — the job runner's
  // `(type, subject_id)` liveness index), and a download may only be minted for
  // one that succeeded. Both are conflicts with the export's current state
  // rather than bad requests, and they share a code for the same reason the
  // three import states do: the client's branch is "look at `details.phase` and
  // wait", and splitting "another export is running" from "this export has not
  // finished" would give it two names for one recovery.
  'EXPORT_IN_PROGRESS',
  // The objects are gone. `exports/` expires after seven days (ADR-0032, D1) and
  // the run is flipped to `expired` lazily at the moment somebody asks for a
  // download. Deliberately NOT a 404: the export existed, the customer's memory
  // of it is correct, and the recovery is specific — request a new export. A 404
  // would send them looking for a wrong id. Deliberately not EXPORT_IN_PROGRESS
  // either: nothing is in progress and waiting will never help.
  'EXPORT_EXPIRED',
  // A site holds one live revenue credential per provider (ADR-0033, D3), so
  // connecting a second one is a conflict with the site's current state rather
  // than a bad request. Its own code because the recovery is nameable and
  // specific — disconnect the connection that is already there, or rotate its
  // key — and neither of those is what a client does about an
  // `IDEMPOTENCY_CONFLICT`.
  'REVENUE_ALREADY_CONNECTED',
  // The provider rejected the credential during the live connect/rotate probe
  // (ADR-0033, D3): a revoked or mistyped key, or a restricted key missing the
  // read permissions the adapter needs. Nothing is stored. Deliberately NOT
  // `VALIDATION_FAILED` — the request is well-formed and the field is exactly
  // what the customer meant to send; it is the provider that said no, and the
  // remedy is in the provider's dashboard rather than in the form. Deliberately
  // not `PROVIDER_UNAVAILABLE` either: that one is retryable and this is not.
  'REVENUE_CREDENTIAL_REJECTED',
  // Meta refused the ad account token during the connect check (migration
  // 0052): revoked, expired, missing `ads_read`, or unable to see the account.
  // Nothing is stored. Its own code rather than the revenue one because the
  // remedy is in a different dashboard (Meta Business Settings), and a client
  // that branches on the code names the right one.
  'ADS_CREDENTIAL_REJECTED',
  'RATE_LIMITED',
  // The declared range is wider than this surface's ceiling (ADR-0043, D7). Its
  // own code rather than `VALIDATION_FAILED` because the request is well-formed
  // and the recovery is exact and automatable — ask for a narrower window and
  // page — while a validation failure tells a client its parameters are
  // malformed, which sends an integrator looking for a typo that is not there.
  // Deliberately not `RATE_LIMITED` either: nothing about waiting helps, and a
  // `Retry-After` would be a lie.
  'RANGE_TOO_LARGE',
  // The requested range/timezone/grain combination has no rollup that can answer
  // it honestly — a minute grain over a range far past the minute rollup's cap,
  // or `resolution=day` on totals outside UTC (docs snapshot 02 §15).
  // Client-correctable: pick a coarser grain or a shorter range. Since ADR-0079
  // the timezone alone is no longer a cause: every offset in force is a whole
  // number of the fifteen-minute atom the reads compose from.
  'RESOLUTION_NOT_AVAILABLE',
  // An event definition's name is already used on this site (ADR-0034, D3).
  // Its own code rather than IDEMPOTENCY_CONFLICT because the recovery is
  // nameable and specific -- pick another name, or edit the definition that
  // already owns this one -- and because the name is not free even when the
  // other definition is archived: the ClickHouse rows it produced still group
  // under it, so "archive it and retry" is NOT the remedy a client should infer.
  'EVENT_DEFINITION_NAME_TAKEN',
  // Someone else published a different version of this definition between the
  // caller reading it and acting (ADR-0034, D3). Deliberately not a generic
  // conflict: the client's recovery is exact and automatable -- re-read the
  // definition, show the user what is now live, and let them decide -- and
  // `details.published_version` is the value it needs to do that.
  'EVENT_DEFINITION_VERSION_CONFLICT',

  // Downstream and readiness
  'IMPORT_FAILED',
  'PROVIDER_UNAVAILABLE',
  'DATA_NOT_READY',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

declare const EXTENSION_ERROR_CODE: unique symbol

/**
 * A code contributed by an optional surface rather than declared above.
 *
 * Branded with a `unique symbol` no value can satisfy, so the only way to
 * produce one is a deliberate cast in the module that owns the surface — which
 * means `new ApiError('TYPOD_CODE', ...)` is still a compile error everywhere,
 * and a route that throws an extension code has to say so out loud. The brand
 * exists at the type level only; at runtime these are ordinary strings that
 * `registerErrorCodes` has taught the two lookups about.
 */
export type ExtensionErrorCode = string & { readonly [EXTENSION_ERROR_CODE]: true }

/**
 * Default HTTP status per code.
 *
 * Kept in one table so a code cannot mean 403 on one route and 402 on another.
 * `satisfies` rather than a type annotation, because the widened `ERROR_STATUS`
 * below has to accept the codes an optional surface registers at mount time
 * (`registerErrorCodes`) — and a `Record<string, number>` on this literal would
 * have stopped catching the thing the table exists for: a code added to
 * `ERROR_CODES` with no status beside it.
 */
const PRODUCT_ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  // Authenticated, but this sensitive action needs a recent re-authentication.
  REAUTH_REQUIRED: 403,

  // 403 and deliberately not 402: this contract has no notion of payment, and a
  // suspended site is a site an operator closed. The client is forbidden to read
  // it in exactly the sense `FORBIDDEN` means; the separate code exists so the
  // reason can be named rather than so the status can differ.
  SITE_SUSPENDED: 403,

  SITE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  RESOLUTION_NOT_AVAILABLE: 400,
  // An ingest batch over the contract's row or byte limit (docs snapshot 02
  // §7.3). Distinct from a schema failure: the client must send less, not fix a
  // field.
  PAYLOAD_TOO_LARGE: 413,
  IDEMPOTENCY_CONFLICT: 409,
  ALREADY_MEMBER: 409,
  // A conflict with the current state of the account, in the same sense as the
  // other 409s here: the request is well-formed and permitted, and the resource
  // is not in a state that admits it.
  ACCOUNT_DELETION_BLOCKED: 409,
  // Both are conflicts with the resource's current state in the same sense as
  // the other 409s here: the request is well-formed and permitted, and the
  // import is simply not in a state that admits it.
  IMPORT_IN_PROGRESS: 409,
  IMPORT_UPLOAD_MISSING: 409,
  IMPORT_ROLLBACK_UNAVAILABLE: 409,
  EXPORT_IN_PROGRESS: 409,
  // Both are conflicts with the resource's current state, like their neighbours
  // here: the request is well-formed and permitted, and the definition is
  // simply not in a state that admits it.
  EVENT_DEFINITION_NAME_TAKEN: 409,
  EVENT_DEFINITION_VERSION_CONFLICT: 409,
  // 410 Gone, and the only one in this catalog. It is the exact meaning: the
  // resource was here, it is not any more, and the condition is permanent. A 404
  // would say it never existed and a 409 would invite a retry.
  EXPORT_EXPIRED: 410,
  // A conflict with the site's current state, in the same sense as the other
  // 409s here: the request is well-formed and permitted, and the site already
  // holds a live connection to that provider.
  REVENUE_ALREADY_CONNECTED: 409,
  RATE_LIMITED: 429,
  // 400, with the rest of the client-correctable family: the caller sent a range
  // this surface will not serve, and the fix is in their next request.
  RANGE_TOO_LARGE: 400,

  IMPORT_FAILED: 422,
  // 422 for the same reason `IMPORT_FAILED` is: the request is syntactically
  // fine and could not be carried out because the *content* — here, the secret
  // itself — is not usable. Not retryable: repeating it with the same key gets
  // the same answer.
  REVENUE_CREDENTIAL_REJECTED: 422,
  // 422 for `REVENUE_CREDENTIAL_REJECTED`'s reason: the request is well-formed
  // and the token in it is not usable. Not retryable.
  ADS_CREDENTIAL_REJECTED: 422,
  PROVIDER_UNAVAILABLE: 503,
  DATA_NOT_READY: 503,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} satisfies Record<ErrorCode, number>

/**
 * Status per code: every product code, plus whatever an optional surface has
 * registered (`registerErrorCodes`).
 */
export const ERROR_STATUS: Record<string, number> = { ...PRODUCT_ERROR_STATUS }

/**
 * The set `isErrorCode` answers from. Seeded with the product catalog and grown
 * by `registerErrorCodes`.
 */
const KNOWN_ERROR_CODES = new Set<string>(ERROR_CODES)

/**
 * Register the codes an optional surface contributes, with their statuses.
 *
 * The catalog above is the *product* contract and stays a closed union: a
 * surface that is not part of every deployment cannot add members to a type the
 * whole repository branches on. What it can do is teach the two runtime
 * lookups — `statusForErrorCode` and `isErrorCode` — about codes it will throw,
 * so the shared error handler answers the right status for them and a client
 * helper recognises them. Registration is idempotent and additive; re-declaring
 * a product code with a different status is refused, because a code meaning two
 * statuses is the exact thing this table exists to prevent.
 */
export function registerErrorCodes(entries: Readonly<Record<string, number>>): void {
  for (const [code, status] of Object.entries(entries)) {
    const existing = ERROR_STATUS[code]
    if (existing !== undefined && existing !== status) {
      throw new Error(
        `error code ${code} is already registered with status ${existing}; refusing ${status}`,
      )
    }
    ERROR_STATUS[code] = status
    KNOWN_ERROR_CODES.add(code)
  }
}

/**
 * Codes a client may safely retry as-is.
 *
 * Used by the collector retry contract: docs snapshot 02 §7.2 requires a queue
 * write failure to surface as a retryable 503, never as a fake success.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'DATA_NOT_READY',
  'SERVICE_UNAVAILABLE',
])

export const errorCodeSchema = z.enum(ERROR_CODES)

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    request_id: z.string(),
    details: z.record(z.string(), z.unknown()).default({}),
  }),
})

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>

/** Whether `value` is a code this deployment knows — product or registered. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value)
}

export function statusForErrorCode(code: ErrorCode | ExtensionErrorCode): number {
  return ERROR_STATUS[code] ?? PRODUCT_ERROR_STATUS.INTERNAL_ERROR
}

export function isRetryableErrorCode(code: ErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code)
}

export function buildErrorEnvelope(input: {
  code: ErrorCode | ExtensionErrorCode
  message: string
  requestId: string
  details?: Record<string, unknown>
}): ErrorEnvelope {
  return {
    error: {
      // The envelope's declared type is the product union; a registered
      // extension code travels in the same field and is a string on the wire.
      code: input.code as ErrorCode,
      message: input.message,
      request_id: input.requestId,
      details: input.details ?? {},
    },
  }
}

/**
 * Error carrying a contract code, so a throw site can decide the response shape
 * without every handler translating exceptions by hand.
 */
export class ApiError extends Error {
  readonly code: ErrorCode | ExtensionErrorCode
  readonly status: number
  readonly details: Record<string, unknown>
  /** Whether the message is safe to show a client; internal text is replaced. */
  readonly expose: boolean

  constructor(
    code: ErrorCode | ExtensionErrorCode,
    message: string,
    options: {
      details?: Record<string, unknown>
      status?: number
      expose?: boolean
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ApiError'
    this.code = code
    this.status = options.status ?? statusForErrorCode(code)
    this.details = options.details ?? {}
    this.expose = options.expose ?? true
  }
}
