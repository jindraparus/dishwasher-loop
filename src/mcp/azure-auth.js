import { InteractiveBrowserCredential } from "@azure/identity";

export class AzureTokenProvider {
  constructor({
    tenantId,
    clientId,
    scope,
    credential = new InteractiveBrowserCredential({
      tenantId,
      clientId,
      browserCustomizationOptions: {
        successMessage: "Dishwasher Loop sign-in succeeded. You can close this window.",
        errorMessage: "Dishwasher Loop sign-in failed. Return to VS Code for details.",
      },
    }),
    now = Date.now,
  }) {
    this.scope = scope;
    this.credential = credential;
    this.now = now;
  }

  async getAccessToken() {
    let accessToken;
    try {
      accessToken = await this.credential.getToken(this.scope);
    } catch (error) {
      throw new Error(classifyAuthenticationError(error), { cause: error });
    }
    if (!accessToken?.token) {
      throw new Error(
        "Microsoft sign-in did not return an access token. Sign in again and verify "
        + "the Entra client ID, tenant ID, and delegated scope.",
      );
    }
    if (!Number.isFinite(accessToken.expiresOnTimestamp)
      || accessToken.expiresOnTimestamp <= this.now()) {
      throw new Error(
        "Microsoft authentication has expired. Run the live-data tool again to sign in.",
      );
    }
    return accessToken.token;
  }
}

function classifyAuthenticationError(error) {
  const code = String(error?.errorCode || error?.code || "").toLowerCase();
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (code.includes("cancel") || message.includes("cancel")) {
    return "Microsoft sign-in was canceled. Run the live-data tool again to retry.";
  }
  if (code.includes("invalid_scope") || message.includes("invalid scope")
    || code.includes("invalid_client") || code.includes("unauthorized_client")
    || message.includes("aadsts700016") || message.includes("aadsts65005")) {
    return "Microsoft sign-in configuration was rejected. Verify the Entra client ID, "
      + "tenant ID, delegated API scope, public-client redirect, and admin consent.";
  }
  if (code.includes("interaction_required") || message.includes("interaction_required")) {
    return "Microsoft authentication requires interaction. Run the live-data tool again "
      + "and complete the browser sign-in.";
  }
  return "Microsoft sign-in failed. Retry the live-data tool and verify the Entra "
    + "tenant, public-client registration, delegated scope, and account access.";
}
