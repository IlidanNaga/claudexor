import type { PinnedVendorCliVersion } from "@claudexor/util";

/**
 * The ONE Claude vendor-CLI version this Claudexor release is verified
 * against — the pinned-install SSOT (issue #89). Two readers alias it and
 * therefore can never drift apart:
 * - `CLAUDE_EFFORT_SNAPSHOT_VERIFIED_AGAINST` (effort-snapshot trust gate),
 * - the remote harness installer's exact `@anthropic-ai/claude-code@<v>` pin.
 * `CLAUDE_KNOWN_MODELS_VERIFIED_AGAINST` deliberately does NOT alias it: that
 * stamp records when the hint list was last actually re-verified, and a pin
 * bump never re-checks model ids.
 * Bump it ONLY while re-recording the effort snapshot (`--help` capture) and
 * the recordable fixtures against the same CLI build — the stamp is a
 * verification claim, not a wish.
 */
export const CLAUDE_VENDOR_CLI_VERSION: PinnedVendorCliVersion = "2.1.281";
