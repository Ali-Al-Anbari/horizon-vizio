function emit(log, fields) {
  try { log(`horizon_pairing_diagnostic ${JSON.stringify(fields)}`); }
  catch (_error) { /* Diagnostics must not affect pairing behavior. */ }
}

export function startWithDiagnostic(pairing, args, objectTag, log = console.info) {
  let before;
  try { before = pairing.read(); } catch (_error) { /* Continue without the optional snapshot. */ }
  const result = pairing.start(...args);
  try {
    const after = pairing.read();
    emit(log, {
      event: "start",
      objectTag,
      pendingBefore: before?.pending?.length ?? null,
      pendingAfter: after.pending.length,
      persisted: Boolean(result.id && after.pending.some(item => item.id === result.id)),
      outcome: result.error || "created",
    });
  } catch (_error) { /* Diagnostics must not affect pairing behavior. */ }
  return result;
}

export function lookupWithDiagnostic(pairing, codeHash, objectTag, log = console.info, now = Date.now) {
  let before;
  let matching;
  try {
    before = pairing.read();
    matching = before.pending.find(item => item.codeHash === codeHash);
  } catch (_error) { /* Continue without the optional snapshot. */ }
  const result = pairing.lookup(codeHash);
  try {
    const after = pairing.read();
    const timestamp = now();
    emit(log, {
      event: "lookup",
      objectTag,
      pendingBefore: before?.pending?.length ?? null,
      pendingAfter: after.pending.length,
      matchingPending: Boolean(matching?.state === "pending" && timestamp < matching.expiresAt),
      matchingExpired: Boolean(matching && timestamp >= matching.expiresAt),
      outcome: result.error || "found",
    });
  } catch (_error) { /* Diagnostics must not affect pairing behavior. */ }
  return result;
}
