/** Keep the literal require lazy in both npm modules and the single-file build.
 * Native fetch initializes its dispatcher before consulting our per-call wrapper.
 * An eager import here would instead install this dependency's default Agent.
 */
export function existingDispatcher() {
  return require("undici").getGlobalDispatcher();
}
