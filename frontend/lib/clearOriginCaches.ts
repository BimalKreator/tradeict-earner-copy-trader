/**
 * Clear every Cache Storage bucket for this origin.
 * Failures must never block logout / navigation.
 */
export async function clearOriginCaches(): Promise<void> {
  try {
    if (typeof window === "undefined" || !("caches" in window)) return;
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* never block logout */
  }
}
