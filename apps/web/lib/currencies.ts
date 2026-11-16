/**
 * The reporting-currency vocabulary, and how to print money in it.
 *
 * **This list is a copy, and the original is server-side** —
 * `packages/domain/src/reporting-currency.ts`, which `apps/web` may not import
 * (D-218: the frontend depends on `@openanalytics/contracts` and nothing
 * else). The contract types it as a bare `string`, so the closed set does not
 * reach us as a union either.
 *
 * Copying it is what the contract asks for: *"Build the picker from a fixed
 * list in the UI and this error never fires"* (frontend_api_contract, Reporting
 * currency). The alternative — a free-text field — is the failure the server
 * list exists to prevent: `ZZZ` passes the `^[A-Z]{3}$` check and a site set to
 * it converts nothing, producing an entirely empty revenue dashboard from a
 * typo with no error anywhere to explain it.
 *
 * The drift risk is real and bounded: a code added server-side is simply
 * missing from our picker until it is added here, and a code removed
 * server-side becomes a `400 VALIDATION_FAILED` naming `reporting_currency`.
 * Neither corrupts anything. Adding one is a one-line change in both places.
 */

/**
 * What the ECB daily reference feed publishes, plus EUR itself (the base,
 * which the feed does not quote against itself). A site reporting in one of
 * these can have every foreign transaction converted.
 *
 * HRK and RUB are deliberately absent — the ECB stopped publishing both, so a
 * site set to either would convert nothing.
 */
export const ECB_REFERENCE_CURRENCIES: readonly string[] = [
  "EUR",
  "AUD",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
  "ZAR",
];

/**
 * Settlement currencies a provider commonly pays out in that the ECB does not
 * publish.
 *
 * Accepted as a reporting currency — refusing a customer their own settlement
 * currency would be worse — with a consequence the picker has to say out loud:
 * until a full-coverage rate source lands, a site reporting in one of these
 * converts nothing that is not already in it, so every transaction in another
 * currency stays in the unconverted remainder.
 */
export const ADDITIONAL_REPORTING_CURRENCIES: readonly string[] = [
  "AED",
  "ARS",
  "CLP",
  "COP",
  "CRC",
  "DOP",
  "EGP",
  "GTQ",
  "KES",
  "MAD",
  "NGN",
  "PEN",
  "PKR",
  "QAR",
  "SAR",
  "TWD",
  "UAH",
  "UYU",
  "VND",
];

const ECB = new Set(ECB_REFERENCE_CURRENCIES);

/** Whether the ECB publishes a daily reference rate for this code. */
export function isEcbConvertible(code: string): boolean {
  return ECB.has(code.trim().toUpperCase());
}

/**
 * "US Dollar" for "USD", from the platform rather than a table of fifty.
 *
 * `Intl.DisplayNames` throws on a malformed code and returns the code itself
 * when it has no name for it, so a currency we know about but the runtime does
 * not still renders as its code rather than blanking the option.
 */
export function currencyName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames([locale ?? "en"], { type: "currency" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Money, from the integer minor units the API returns.
 *
 * **Not `minor / 100`.** A minor unit is not always a hundredth: JPY and KRW
 * are zero-decimal and both are on the list above, so dividing by 100 would
 * report a ¥1,200 sale as ¥12. `Intl` already knows each currency's exponent —
 * asking it for the fraction digits and scaling by that is the only version
 * that is right for all fifty.
 */
export function formatMoney(
  minor: number,
  currency: string,
  locale?: string
): string {
  const format = new Intl.NumberFormat(locale, {
    currency,
    style: "currency",
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

/**
 * Money for an axis label: "$1.2K", "€300", "¥12K". Same minor-unit scaling as
 * `formatMoney`, compact notation, at most one fraction digit.
 */
export function formatMoneyCompact(
  minor: number,
  currency: string,
  locale?: string
): string {
  const digits =
    new Intl.NumberFormat(locale, { currency, style: "currency" }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, {
    currency,
    style: "currency",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / 10 ** digits);
}
