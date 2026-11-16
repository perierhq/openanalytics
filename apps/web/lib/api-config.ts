/**
 * Where the dashboard finds its services, and whether it runs on fixtures.
 * Kept free of imports so a module that only needs these values (an image
 * URL, a mock-mode check) does not pull the API client into its bundle or
 * its tests.
 */

/**
 * The three service origins this browser talks to, and the one place they are
 * named.
 *
 * Deployment configuration with **no default**, deliberately. They used to
 * fall back to our own hosts, which is fine right up until somebody else runs
 * this build: their dashboard would then read our api, their tracker would
 * post events to our collector, and nothing on screen would say so. An empty
 * value makes every call relative, which fails on the first request instead of
 * succeeding against the wrong deployment.
 *
 * `NEXT_PUBLIC_*` is inlined at build time — set them for the build, not for
 * the container.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
export const REALTIME_BASE_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "";
/** The collector host — serves the tracker bundle and takes events (ADR-0020). */
export const COLLECTOR_BASE_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL ?? "";

/**
 * One switch between the mock data every screen was built on and the live api.
 *
 * **Live is the default, and mock is what you opt into.** It used to be the
 * other way around (`NEXT_PUBLIC_LIVE_API=1` turned live on), and on
 * 2026-07-26 that variable went missing from a production build: the deployed
 * app quietly became a demo — fake numbers, and `SessionGate` standing aside so
 * `/dashboard` opened for anyone, with nothing on the page saying so.
 *
 * A forgotten variable has to fail towards the safe side. Forgetting this one
 * now costs a designer their local fixtures; forgetting the old one exposed an
 * unguarded dashboard to the internet.
 *
 * Set `NEXT_PUBLIC_MOCK_API=1` in `.env.local` to work against the fixtures
 * with no api behind them.
 */
export const LIVE_API = process.env.NEXT_PUBLIC_MOCK_API !== "1";
