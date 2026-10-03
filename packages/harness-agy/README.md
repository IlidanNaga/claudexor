# @claudexor/harness-agy

Adapter for Google's Antigravity CLI (`agy`): translates
`agy -p --output-format stream-json` into typed `HarnessEvent`s.

Accounts use NAMED credential-profile bindings only (there is no engine-default
agy credential). Every binding has a Claudexor-owned HOME that scopes vendor
state under `$HOME/.gemini/...`; credential custody is platform-defined.
On Darwin, Claudexor lazily prepares the profile's own
`Library/Keychains/login.keychain-db` before an agy child starts. When setup
succeeds this prevents the missing-keychain prompt; an unsafe profile path
refuses that child before it can trigger SecurityAgent, while an operational
setup miss leaves the vendor's own file fallback available. The implementation
bootstraps the DB under a neutral filename and adopts the canonical name,
because Apple's `security` tool treats a path containing `login.keychain` as a
user search-list entry. This keeps host default/list preferences untouched.
The vendor still owns the item; no host Keychain is bridged and no credential
bytes are copied. Linux keeps the config-file/HOME route.
Windows uses the current OS user's Credential Manager identity, permits one
enabled binding, and treats HOME as state scoping rather than an independent
Google identity.
Readiness always comes from the bounded vendor `/model` probe, never from the
presence or absence of `antigravity-oauth-token`. See `src/profile.ts` for the
route and verification contract.

Fixtures under `fixtures/` pin the recorded 1.1.13 stream shapes; see
`fixtures/manifest.yaml` for provenance and stream-semantics expectations.
