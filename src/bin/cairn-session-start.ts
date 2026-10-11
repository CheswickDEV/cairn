#!/usr/bin/env node
/** Legacy hook compatibility entry point. Cairn is explicit-only (ADR-0010).
 * Kept so existing host settings do not fail after an update. Intentionally no
 * stdin/transcript reads, ledger access, context injection, or output.
 * Re-run `cairn install` to remove the obsolete hook registration.
 */
export {};
