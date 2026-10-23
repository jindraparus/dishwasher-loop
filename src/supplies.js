import express from "express";

export function capsuleSettingsRouter(storage, config) {
  const router = express.Router();
  router.put("/api/supplies/capsules", (request, response, next) => {
    const browserSession = /(?:^|;\s*)AppServiceAuthSession=([^;]+)/.test(
      request.headers.cookie || "",
    );
    if (request.headers.origin !== new URL(config.redirectUri).origin
      || request.headers.authorization
      || (config.requireMicrosoftAuth && !browserSession)) {
      response.status(403).json({ error: "Změna zásob je povolena pouze z přihlášeného přehledu." });
      return;
    }
    if (!request.is("application/json")) {
      response.status(415).json({ error: "Požadavek musí obsahovat JSON." });
      return;
    }
    next();
  }, express.json({ limit: "1kb" }), async (request, response, next) => {
    try {
      const capsuleCount = await storage.setCapsuleCount(request.body?.capsuleCount);
      response.json({ capsuleCount });
    } catch (error) {
      if (error instanceof RangeError) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });
  router.use((error, request, response, next) => {
    if (error.type === "entity.parse.failed" || error.type === "entity.too.large") {
      response.status(error.status).json({ error: "Neplatný požadavek JSON." });
      return;
    }
    next(error);
  });
  return router;
}
