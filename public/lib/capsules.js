export const CAPSULE_COUNT_STORAGE_KEY = "dishwasher.capsuleCount";

export function readCapsuleCount(storage = localStorage) {
  return parseCapsuleCount(storage.getItem(CAPSULE_COUNT_STORAGE_KEY));
}

export function parseCapsuleCount(value) {
  if (typeof value !== "string" || !/^\d{1,3}$/.test(value.trim())) {
    return null;
  }
  const count = Number.parseInt(value, 10);
  return count <= 999 ? count : null;
}
