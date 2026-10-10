const EMAIL_CLAIMS = new Set([
  "email",
  "preferred_username",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
]);

export function requireAllowedMicrosoftUser(config) {
  return (request, response, next) => {
    if (!config.requireMicrosoftAuth) {
      next();
      return;
    }

    const identity = getMicrosoftUserIdentity(request.headers);
    if (!identity.authenticated) {
      response.status(401).type("text").send("Je vyžadováno přihlášení přes Microsoft.");
      return;
    }
    const allowedPrincipalIds = config.allowedPrincipalIds
      || (config.allowedPrincipalId ? [config.allowedPrincipalId] : []);
    const principalMatches = allowedPrincipalIds.some(
      (principalId) => identity.principalIds.includes(principalId.toLowerCase()),
    );
    const emailMatches = allowedPrincipalIds.length === 0
      && config.allowedEmail
      && identity.emails.includes(config.allowedEmail);
    if (!principalMatches && !emailMatches) {
      response.status(403).type("text").send("Tento účet Microsoft nemá oprávnění.");
      return;
    }

    next();
  };
}

export function getMicrosoftUserEmail(headers) {
  return getMicrosoftUserIdentity(headers).emails[0] || "";
}

export function getMicrosoftUserIdentity(headers) {
  const principal = parsePrincipal(headers["x-ms-client-principal"]);
  const claims = principal?.claims || [];
  const emails = claims
    .filter((claim) => EMAIL_CLAIMS.has(claim.typ) && claim.val)
    .map((claim) => normalize(claim.val));
  const principalIds = claims
    .filter((claim) => [
      "oid",
      "http://schemas.microsoft.com/identity/claims/objectidentifier",
    ].includes(claim.typ) && claim.val)
    .map((claim) => normalize(claim.val));

  const headerName = normalize(headers["x-ms-client-principal-name"]);
  const headerId = normalize(headers["x-ms-client-principal-id"]);
  if (headerName) {
    emails.push(headerName);
  }
  if (headerId) {
    principalIds.push(headerId);
  }

  return {
    authenticated: Boolean(principal || headerId || headerName),
    emails: [...new Set(emails)],
    principalIds: [...new Set(principalIds)],
  };
}

function parsePrincipal(encodedPrincipal) {
  if (typeof encodedPrincipal !== "string" || !encodedPrincipal) {
    return null;
  }

  try {
    const principal = JSON.parse(Buffer.from(encodedPrincipal, "base64").toString("utf8"));
    return Array.isArray(principal.claims) ? principal : null;
  } catch {
    return null;
  }
}

function normalize(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
