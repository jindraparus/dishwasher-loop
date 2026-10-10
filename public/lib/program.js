const PROGRAM_ACTIVITY_MAX_AGE_MS = 10 * 60 * 1000;

export function findStatusValue(diagnostic, keySuffix) {
  return diagnostic?.statusItems?.find(
    (item) => String(item.key).endsWith(keySuffix),
  )?.value;
}

export function adjustedRemainingSeconds(program, now = Date.now()) {
  if (!Number.isFinite(program?.remainingSeconds)) {
    return null;
  }
  const updatedAt = new Date(program.remainingUpdatedAt).valueOf();
  const elapsed = Number.isFinite(updatedAt)
    ? Math.max(0, Math.floor((now - updatedAt) / 1000))
    : 0;
  return Math.max(0, Math.round(program.remainingSeconds - elapsed));
}

export function isProgramActive(diagnostic, now = Date.now()) {
  const operationState = findStatusValue(diagnostic, ".OperationState");
  if (String(operationState).endsWith(".Run")) {
    return true;
  }

  const program = diagnostic?.program;
  const updatedAt = new Date(program?.remainingUpdatedAt).valueOf();
  const age = now - updatedAt;
  return Number.isFinite(program?.remainingSeconds)
    && program.remainingSeconds > 0
    && Number.isFinite(updatedAt)
    && age >= 0
    && age <= PROGRAM_ACTIVITY_MAX_AGE_MS;
}
