import crypto from "node:crypto";
import { ContractError } from "../../contracts/src/index.mjs";

/**
 * Confidential Web OIDC BFF + Single-Use App Link Ticket + Session Family Replay Guard.
 */
export function computeS256Challenge(codeVerifier) {
  return crypto
    .createHash("sha256")
    .update(codeVerifier, "ascii")
    .digest("base64url");
}

function isSafeSsoSubject(ssoSubject) {
  if (!ssoSubject || typeof ssoSubject !== "string") return false;
  const trimmed = ssoSubject.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return false;
  if (/[\/\\?#\0\r\n\s]/.test(trimmed)) return false;
  return /^[a-zA-Z0-9._:-]{2,128}$/.test(trimmed);
}

const SENSITIVE_SITE_DATA_KEYS = new Set([
  "delegated_secret",
  "password",
  "raw_token",
  "cas_tgc",
  "cas_jsessionid",
  "sso_access_token",
  "sso_refresh_token",
  "accessToken",
  "apiKey",
  "quota",
  "usedQuota",
  "peachBalance",
  "peachUsed",
  "processedIdempotencyKeys"
]);

export function sanitizeReturnToPath(raw) {
  if (typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    /[\r\n\0]/.test(trimmed)
  ) {
    return "/";
  }
  try {
    const parsed = new URL(trimmed, "https://campus.yellowpeachxgp.com");
    if (parsed.origin !== "https://campus.yellowpeachxgp.com") return "/";
    return `${parsed.pathname}${parsed.search || ""}`;
  } catch {
    return "/";
  }
}

export class CloudIdentityService {
  constructor(store, options = {}) {
    this.store = store;
    this.expectedIssuer =
      options.expectedIssuer ||
      process.env.OIDC_EXPECTED_ISSUER ||
      "https://sso.xpeach.codes/t/acme";
    this.ssoBaseUrl =
      options.ssoBaseUrl ||
      this.expectedIssuer.replace(/\/t\/[^/]+\/?$/, "").replace(/\/+$/, "");
    this.clientId =
      options.clientId || process.env.OIDC_CLIENT_ID || "day-in-school-cloud";
    this.clientSecret =
      options.clientSecret || process.env.OIDC_CLIENT_SECRET || "";
    this.internalServiceKey =
      options.internalServiceKey || process.env.SSO_INTERNAL_SERVICE_KEY || "";
    this.redirectUri =
      options.redirectUri ||
      process.env.OIDC_REDIRECT_URI ||
      "https://campus.yellowpeachxgp.com/api/v1/auth/oidc/callback";
    this.publicBaseUrl =
      options.publicBaseUrl ||
      process.env.PUBLIC_BASE_URL ||
      "https://campus.yellowpeachxgp.com";
    const signingMaterial = options.sessionSecret || process.env.CLOUD_SESSION_SIGNING_SECRET;
    if (String(signingMaterial || "").startsWith("secret://")) throw new Error("Unresolved signing secret reference");
    const production = (options.environment || process.env.NODE_ENV) === "production";
    if (production && (!signingMaterial || Buffer.byteLength(signingMaterial) < 32 || String(signingMaterial).startsWith("secret://"))) {
      throw new Error("Production requires CLOUD_SESSION_SIGNING_SECRET with at least 32 bytes of resolved secret material");
    }
    this.sessionSecret = crypto.createHash("sha256")
      .update(signingMaterial || crypto.randomBytes(32)).digest();
    this.requireAdminAccess = options.requireAdminAccess !== undefined
      ? Boolean(options.requireAdminAccess) : process.env.CLOUD_REQUIRE_ADMIN_ACCESS !== "false";
    this.ssoCodeExchanger = options.ssoCodeExchanger || null;
    this.httpTimeoutMs = Number(options.httpTimeoutMs) || 8_000;
    this.allowSyntheticTestCodes =
      options.allowSyntheticTestCodes !== undefined
        ? Boolean(options.allowSyntheticTestCodes)
        : !this.clientSecret && process.env.NODE_ENV !== "production";
  }

  startWebTransaction({ returnTo = "/" } = {}, nowMs = Date.now()) {
    const loginTxn = `wtxn_${crypto.randomBytes(18).toString("base64url")}`;
    const serverState = crypto.randomBytes(24).toString("base64url");
    const serverNonce = crypto.randomBytes(24).toString("base64url");
    const serverVerifier = crypto.randomBytes(32).toString("base64url");
    const serverChallenge = computeS256Challenge(serverVerifier);
    const expiresAtMs = nowMs + 15 * 60 * 1000;

    this.store.pruneAuthEphemera?.(nowMs);
    this.store.authTransactions.set(loginTxn, {
      loginTxn,
      flowKind: "WEB_CONSOLE",
      returnTo: sanitizeReturnToPath(returnTo),
      installEphemeralId: "web_console_session",
      mobileCodeChallenge: null,
      deviceLabel: "Campus Cloud Web Console",
      serverState,
      serverNonce,
      serverVerifier,
      serverChallenge,
      createdAtMs: nowMs,
      expiresAtMs,
      status: "INITIATED"
    });
    this.store.indexAuthTransaction?.(loginTxn, this.store.authTransactions.get(loginTxn));
    this.store.saveSnapshot?.();

    return {
      login_txn: loginTxn,
      redirect_url: this.buildOidcRedirectUrl(loginTxn, nowMs)
    };
  }

  startMobileTransaction({ installEphemeralId, codeChallenge, codeChallengeMethod, deviceLabel }, nowMs = Date.now()) {
    if (!installEphemeralId || installEphemeralId.length < 8) {
      throw new ContractError("BAD_REQUEST", "install_ephemeral_id must be at least 8 characters");
    }
    if (codeChallengeMethod !== "S256") {
      throw new ContractError("BAD_REQUEST", "Only S256 PKCE code_challenge_method is permitted");
    }
    if (!codeChallenge || codeChallenge.length < 43) {
      throw new ContractError("BAD_REQUEST", "Invalid S256 code_challenge length");
    }
    const loginTxn = `txn_${crypto.randomBytes(18).toString("base64url")}`;
    const serverState = crypto.randomBytes(24).toString("base64url");
    const serverNonce = crypto.randomBytes(24).toString("base64url");
    const serverVerifier = crypto.randomBytes(32).toString("base64url");
    const serverChallenge = computeS256Challenge(serverVerifier);
    const expiresAtMs = nowMs + 15 * 60 * 1000;

    this.store.pruneAuthEphemera?.(nowMs);
    this.store.authTransactions.set(loginTxn, {
      loginTxn,
      installEphemeralId,
      mobileCodeChallenge: codeChallenge,
      deviceLabel: deviceLabel || "Android Client",
      serverState,
      serverNonce,
      serverVerifier,
      serverChallenge,
      createdAtMs: nowMs,
      expiresAtMs,
      status: "INITIATED"
    });
    this.store.indexAuthTransaction?.(loginTxn, this.store.authTransactions.get(loginTxn));
    this.store.saveSnapshot?.();

    return {
      login_txn: loginTxn,
      authorize_url: `${this.publicBaseUrl}/api/v1/auth/oidc/start?txn=${encodeURIComponent(loginTxn)}`,
      expires_at: new Date(expiresAtMs).toISOString()
    };
  }

  buildOidcRedirectUrl(loginTxn, nowMs = Date.now()) {
    const txn = this.store.authTransactions.get(loginTxn);
    if (
      !txn ||
      nowMs > txn.expiresAtMs ||
      (txn.status !== "INITIATED" && txn.status !== "REDIRECTED_TO_SSO")
    ) {
      throw new ContractError("BAD_REQUEST", "Invalid or expired login transaction");
    }
    txn.status = "REDIRECTED_TO_SSO";
    this.store.saveSnapshot?.();
    const authEndpoint = `${this.expectedIssuer}/auth`;
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "openid profile email offline_access tenant",
      state: txn.serverState,
      nonce: txn.serverNonce,
      code_challenge: txn.serverChallenge,
      code_challenge_method: "S256",
      sso_auto: "1"
    });
    return `${authEndpoint}?${params.toString()}`;
  }

  getMobileTransactionStatus(loginTxn, nowMs = Date.now()) {
    if (!loginTxn || typeof loginTxn !== "string") {
      throw new ContractError("BAD_REQUEST", "Missing login transaction id");
    }
    const txn = this.store.authTransactions.get(loginTxn);
    if (!txn) {
      return {
        login_txn: loginTxn,
        status: "NOT_FOUND",
        app_ticket: null,
        expired: true
      };
    }
    const expired = nowMs > txn.expiresAtMs;
    let activeTicket = null;
    if (txn.appTicket) {
      const ticketObj = this.store.exchangeTickets.get(txn.appTicket);
      if (ticketObj && ticketObj.consumedAtMs === null && nowMs <= ticketObj.expiresAtMs) {
        activeTicket = txn.appTicket;
      }
    }
    return {
      login_txn: loginTxn,
      status: expired && txn.status !== "COMPLETED" ? "EXPIRED" : txn.status,
      app_ticket: activeTicket,
      expired,
      expires_at: new Date(txn.expiresAtMs).toISOString()
    };
  }

  async loginNativeWithSso(
    { identifier, password, totpCode, installEphemeralId, deviceLabel },
    nowMs = Date.now()
  ) {
    const cleanIdentifier = String(identifier || "").trim();
    const rawPassword = typeof password === "string" ? password : "";
    const cleanTotp = typeof totpCode === "string" ? totpCode.trim() : "";

    if (!cleanIdentifier || !rawPassword) {
      throw new ContractError("BAD_REQUEST", "请输入 XPeach 用户名（或邮箱）与登录密码");
    }

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (this.internalServiceKey) {
      headers["X-Internal-Service-Key"] = this.internalServiceKey;
    }

    const resp = await fetch(`${this.ssoBaseUrl.replace(/\/+$/, "")}/api/internal/native-auth`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: cleanIdentifier,
        password: rawPassword,
        totp_code: cleanTotp || undefined,
        client_id: this.clientId,
        tenant_slug: "acme",
        install_ephemeral_id: installEphemeralId || undefined
      }),
      signal: AbortSignal.timeout(this.httpTimeoutMs)
    });

    const data = await resp.json().catch(() => ({}));
    if (data && data.totp_required && !data.ok) {
      return {
        ok: false,
        totp_required: true,
        error: data.error || "totp_required",
        message: data.message || "该账号已开启两步验证 (2FA)，请输入 6 位动态验证码。"
      };
    }

    if (!resp.ok || !data || !data.ok || !data.user) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        data?.message || "XPeach 用户名/邮箱或密码不正确"
      );
    }

    const ssoUser = data.user;
    let peachWallet = data.peach_wallet || ssoUser.peach_wallet || null;

    if (ssoUser.sub && isSafeSsoSubject(ssoUser.sub) && this.internalServiceKey) {
      try {
        const peachResp = await fetch(
          `${this.ssoBaseUrl.replace(/\/+$/, "")}/api/v1/users/${encodeURIComponent(ssoUser.sub)}/peach`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              "X-Internal-Service-Key": this.internalServiceKey
            },
            signal: AbortSignal.timeout(this.httpTimeoutMs)
          }
        );
        if (peachResp.ok) {
          const peachData = await peachResp.json();
          const pw = peachData?.peach || peachData?.wallet || peachData?.data;
          if (pw && typeof pw === "object") {
            const bal = Number(pw.peach_balance ?? pw.peachBalance ?? peachWallet?.peachBalance ?? 0);
            const used = Number(pw.peach_used ?? pw.peachUsed ?? peachWallet?.peachUsed ?? 0);
            peachWallet = {
              ...(peachWallet || {}),
              group: pw.group || ssoUser.group || peachWallet?.group || "默认分组",
              affCode: pw.aff_code || pw.affCode || ssoUser.aff_code || peachWallet?.affCode || null,
              peachBalance: bal,
              peachBalanceFormatted: pw.peach_balance_formatted || pw.peachBalanceFormatted || bal.toFixed(2),
              peachQuota: Number(pw.peach_quota ?? pw.peachQuota ?? Math.round(bal * 500000)),
              peachUsed: used,
              peachUsedFormatted: pw.peach_used_formatted || pw.peachUsedFormatted || used.toFixed(2)
            };
          }
        }
      } catch {
        // Keep wallet from native-auth response if secondary fetch fails
      }
    }

    const displayName =
      ssoUser.name || ssoUser.preferred_username || ssoUser.username || ssoUser.email || "XPEACH User";

    const cloudUser = this.store.findOrCreateCloudUser({
      issuer: this.expectedIssuer,
      subject: ssoUser.sub || ssoUser.id,
      displayName,
      username: ssoUser.username || ssoUser.preferred_username || displayName,
      email: ssoUser.email || null,
      emailVerified: Boolean(ssoUser.email_verified),
      group: peachWallet?.group || ssoUser.group || "默认分组",
      affCode: peachWallet?.affCode || ssoUser.aff_code || null,
      role: ssoUser.role || "user",
      peachWallet
    });

    const session = this.issueDeviceSession(
      cloudUser,
      deviceLabel || "Android Native OIDC Client",
      null,
      1,
      nowMs,
      "MOBILE_APP"
    );

    return {
      ok: true,
      totp_required: false,
      session
    };
  }

  async handleOidcCallback({ code, state, iss, simulatedIdTokenClaims }, nowMs = Date.now()) {
    if (!code || !state) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Missing OIDC code or state");
    }
    const txnId = this.store._idxTxnByServerState?.get(state);
    const indexedTxn = txnId ? this.store.authTransactions.get(txnId) : null;
    const txn = indexedTxn?.serverState === state ? indexedTxn : Array.from(this.store.authTransactions.values()).find(t => t.serverState === state);
    if (!txn) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Invalid OIDC state parameter");
    }
    if (
      nowMs > txn.expiresAtMs ||
      (txn.status !== "INITIATED" && txn.status !== "REDIRECTED_TO_SSO")
    ) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "OIDC login transaction expired or already consumed");
    }
    if (iss && iss !== this.expectedIssuer) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", `Untrusted OIDC issuer: ${iss}`);
    }

    txn.status = "CALLBACK_IN_PROGRESS";

    let verifiedClaims;
    const isSyntheticTestCode =
      code.startsWith("sub:") ||
      code.startsWith("sso_code_") ||
      code.startsWith("mock_") ||
      code.startsWith("test_");
    if (this.ssoCodeExchanger) {
      verifiedClaims = await this.ssoCodeExchanger({
        code,
        codeVerifier: txn.serverVerifier,
        expectedIssuer: this.expectedIssuer,
        expectedClientId: this.clientId,
        expectedNonce: txn.serverNonce
      });
    } else if (simulatedIdTokenClaims && this.allowSyntheticTestCodes) {
      verifiedClaims = simulatedIdTokenClaims;
    } else if (!isSyntheticTestCode && this.clientSecret) {
      verifiedClaims = await this.exchangeRealOidcCode({
        code,
        codeVerifier: txn.serverVerifier,
        expectedNonce: txn.serverNonce
      });
    } else if (this.allowSyntheticTestCodes) {
      verifiedClaims = {
        iss: this.expectedIssuer,
        aud: this.clientId,
        sub: code.startsWith("sub:") ? code.slice(4) : `xpeach_user_${crypto.createHash("sha256").update(code).digest("hex").slice(0, 12)}`,
        nonce: txn.serverNonce,
        exp: Math.floor((nowMs + 5 * 60 * 1000) / 1000),
        preferred_username: "campus_student"
      };
    } else {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Synthetic OIDC test codes are disabled in production");
    }

    const audMatches = Array.isArray(verifiedClaims.aud)
      ? verifiedClaims.aud.includes(this.clientId)
      : verifiedClaims.aud === this.clientId;
    if (verifiedClaims.iss !== this.expectedIssuer) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token issuer mismatch");
    }
    if (!audMatches) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token client_id / audience mismatch");
    }
    if (!verifiedClaims.nonce || verifiedClaims.nonce !== txn.serverNonce) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token nonce mismatch");
    }
    if (!verifiedClaims.sub || typeof verifiedClaims.sub !== "string") {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token missing subject");
    }
    if (verifiedClaims.tenant_slug) {
      const expectedSlug = (() => {
        try {
          return new URL(this.expectedIssuer).pathname.split("/").filter(Boolean).pop();
        } catch {
          return null;
        }
      })();
      if (expectedSlug && String(verifiedClaims.tenant_slug) !== expectedSlug) {
        throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token tenant_slug mismatch");
      }
    }
    if (!Number.isFinite(verifiedClaims.exp) || verifiedClaims.exp * 1000 <= nowMs) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token expired");
    }

    const displayName =
      verifiedClaims.name ||
      verifiedClaims.preferred_username ||
      verifiedClaims.username ||
      verifiedClaims.email ||
      "XPEACH User";

    const user = this.store.findOrCreateCloudUser({
      issuer: verifiedClaims.iss,
      subject: verifiedClaims.sub,
      displayName,
      username: verifiedClaims.username || verifiedClaims.preferred_username || displayName,
      email: verifiedClaims.email || null,
      emailVerified: Boolean(verifiedClaims.email_verified),
      group: verifiedClaims.group || verifiedClaims.peach_wallet?.group || "默认分组",
      affCode: verifiedClaims.aff_code || verifiedClaims.peach_wallet?.affCode || null,
      role: verifiedClaims.role || "user",
      ssoCreatedAt: verifiedClaims.sso_created_at || null,
      ssoLastLoginAt: verifiedClaims.sso_last_login_at || null,
      ssoAccessToken: verifiedClaims.sso_access_token || null,
      ssoRefreshToken: verifiedClaims.sso_refresh_token || null,
      peachWallet: verifiedClaims.peach_wallet || null
    });

    txn.status = "CALLBACK_VERIFIED";
    const appTicket = `tkt_${crypto.randomBytes(24).toString("base64url")}`;
    txn.appTicket = appTicket;
    this.store.exchangeTickets.set(appTicket, {
      appTicket,
      loginTxn: txn.loginTxn,
      flowKind: txn.flowKind || "MOBILE_APP",
      issuer: verifiedClaims.iss,
      subject: verifiedClaims.sub,
      displayName,
      username: verifiedClaims.username || verifiedClaims.preferred_username || displayName,
      email: verifiedClaims.email || null,
      emailVerified: Boolean(verifiedClaims.email_verified),
      group: verifiedClaims.group || verifiedClaims.peach_wallet?.group || "默认分组",
      affCode: verifiedClaims.aff_code || verifiedClaims.peach_wallet?.affCode || null,
      role: verifiedClaims.role || "user",
      ssoCreatedAt: verifiedClaims.sso_created_at || null,
      ssoLastLoginAt: verifiedClaims.sso_last_login_at || null,
      ssoAccessToken: verifiedClaims.sso_access_token || null,
      ssoRefreshToken: verifiedClaims.sso_refresh_token || null,
      peachWallet: verifiedClaims.peach_wallet || null,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60 * 1000,
      consumedAtMs: null
    });
    this.store.saveSnapshot?.();

    let webSessionCookie = null;
    if (txn.flowKind === "WEB_CONSOLE") {
      const webSess = this.issueDeviceSession(user, txn.deviceLabel || "Campus Cloud Web Console", null, 1, nowMs, "WEB_CONSOLE");
      webSessionCookie = this.signWebSessionCookie({
        cloudUserId: user.id,
        accessToken: webSess.access_token,
        refreshToken: webSess.refresh_token
      });
    }

    const safeReturnTo = sanitizeReturnToPath(txn.returnTo || "/");
    const joiner = safeReturnTo.includes("?") ? "&" : "?";
    const appLinkUrl =
      txn.flowKind === "WEB_CONSOLE"
        ? `${this.publicBaseUrl}${safeReturnTo}${joiner}web_ticket=${encodeURIComponent(
            appTicket
          )}&txn=${encodeURIComponent(txn.loginTxn)}`
        : `${this.publicBaseUrl}/app-link/auth/callback?ticket=${encodeURIComponent(
            appTicket
          )}&txn=${encodeURIComponent(txn.loginTxn)}`;
    return {
      appTicket,
      loginTxn: txn.loginTxn,
      appLinkUrl,
      webSessionCookie
    };
  }

  async exchangeRealOidcCode({ code, codeVerifier, expectedNonce }) {
    const tokenEndpoint = `${this.expectedIssuer.replace(/\/+$/, "")}/token`;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code_verifier: codeVerifier
    });
    const resp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body,
      signal: AbortSignal.timeout(this.httpTimeoutMs)
    });
    const tokenData = await resp.json().catch(() => ({}));
    if (!resp.ok || !tokenData.id_token) {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        `XPEACH SSO token exchange failed: ${tokenData.error_description || tokenData.error || resp.status}`
      );
    }
    const idTokenParts = String(tokenData.id_token).split(".");
    if (idTokenParts.length !== 3) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Malformed ID Token from XPEACH SSO");
    }
    const idTokenHeader = JSON.parse(Buffer.from(idTokenParts[0], "base64url").toString("utf8"));
    await this.verifyIdTokenSignature(
      `${idTokenParts[0]}.${idTokenParts[1]}`,
      idTokenParts[2],
      idTokenHeader
    );
    const claims = JSON.parse(Buffer.from(idTokenParts[1], "base64url").toString("utf8"));
    if (expectedNonce && (!claims.nonce || claims.nonce !== expectedNonce)) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token nonce mismatch");
    }
    if (tokenData.access_token) {
      claims.sso_access_token = tokenData.access_token;
      if (tokenData.refresh_token) {
        claims.sso_refresh_token = tokenData.refresh_token;
      }
      // 1) Fetch full canonical user profile + 🍑 wallet from /api/internal/user-profile
      try {
        const headers = {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json"
        };
        if (this.internalServiceKey) {
          headers["X-Internal-Service-Key"] = this.internalServiceKey;
        }
        const profileResp = await fetch(`${this.ssoBaseUrl}/api/internal/user-profile`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(this.httpTimeoutMs)
        });
        if (profileResp.ok) {
          const profileData = await profileResp.json();
          const u = profileData?.user;
          if (u && typeof u === "object") {
            claims.sub = u.uuid || u.id || claims.sub;
            claims.username = u.username || claims.preferred_username || claims.username;
            claims.preferred_username = claims.username;
            claims.name = u.name || u.username || claims.name;
            claims.email = u.email || claims.email;
            claims.email_verified = Boolean(u.email_verified);
            claims.group = u.group || "默认分组";
            claims.aff_code = u.aff_code || null;
            claims.role = u.role || "user";
            claims.sso_created_at = u.created_at || null;
            claims.sso_last_login_at = u.last_login_at || null;
            if (u.peach_wallet && typeof u.peach_wallet === "object") {
              claims.peach_wallet = u.peach_wallet;
            }
          }
        }
      } catch {
        // Fallback below
      }

      // 2) Standard OIDC userinfo fallback (whitelist profile fields only; never overwrite iss/aud/nonce/sub/role)
      if (!claims.username) {
        try {
          const meResp = await fetch(`${this.expectedIssuer.replace(/\/+$/, "")}/me`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              Accept: "application/json"
            },
            signal: AbortSignal.timeout(this.httpTimeoutMs)
          });
          if (meResp.ok) {
            const meData = await meResp.json();
            if (meData && typeof meData === "object") {
              if (typeof meData.preferred_username === "string" && meData.preferred_username) {
                claims.preferred_username = meData.preferred_username;
                claims.username = claims.username || meData.preferred_username;
              }
              if (typeof meData.username === "string" && meData.username) {
                claims.username = claims.username || meData.username;
              }
              if (typeof meData.name === "string" && meData.name) {
                claims.name = claims.name || meData.name;
              }
              if (typeof meData.email === "string" && meData.email) {
                claims.email = claims.email || meData.email;
              }
              if (typeof meData.email_verified === "boolean") {
                claims.email_verified = meData.email_verified;
              }
            }
          }
        } catch {
          // Keep id_token claims
        }
      }
    }

    // 3) Ensure live 🍑 wallet is synced from /api/v1/users/:uuid/peach
    if (
      !claims.peach_wallet &&
      claims.sub &&
      isSafeSsoSubject(claims.sub) &&
      (this.internalServiceKey || tokenData.access_token)
    ) {
      try {
        const headers = { Accept: "application/json" };
        if (this.internalServiceKey) {
          headers["X-Internal-Service-Key"] = this.internalServiceKey;
        } else if (tokenData.access_token) {
          headers.Authorization = `Bearer ${tokenData.access_token}`;
        }
        const peachResp = await fetch(
          `${this.ssoBaseUrl}/api/v1/users/${encodeURIComponent(claims.sub)}/peach`,
          {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(this.httpTimeoutMs)
          }
        );
        if (peachResp.ok) {
          const pd = await peachResp.json();
          if (pd && pd.ok) {
            claims.peach_wallet = {
              quota: Number(pd.quota ?? 0),
              usedQuota: Number(pd.usedQuota ?? 0),
              requestCount: Number(pd.requestCount ?? 0),
              group: pd.group || claims.group || "默认分组",
              affCode: pd.affCode || claims.aff_code || "",
              peachBalance: Number(pd.peachBalance ?? 0),
              peachUsed: Number(pd.peachUsed ?? 0),
              peachBalanceFormatted: String(pd.peachBalanceFormatted ?? "0.00"),
              peachUsedFormatted: String(pd.peachUsedFormatted ?? "0.00")
            };
          }
        }
      } catch {
        // Ignore network error
      }
    }

    return claims;
  }

  exchangeWebTicket({ loginTxn, webTicket }, nowMs = Date.now()) {
    const ticket = this.store.exchangeTickets.get(webTicket);
    if (!ticket || ticket.loginTxn !== loginTxn || (ticket.flowKind && ticket.flowKind !== "WEB_CONSOLE")) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Invalid web_ticket or transaction mismatch");
    }
    if (ticket.consumedAtMs !== null) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Single-use web_ticket has already been consumed");
    }
    if (nowMs > ticket.expiresAtMs || nowMs < ticket.issuedAtMs) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Single-use web_ticket expired");
    }
    const txn = this.store.authTransactions.get(loginTxn);
    if (!txn) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Missing web login transaction");
    }
    ticket.consumedAtMs = nowMs;
    txn.status = "COMPLETED";

    const user = this.store.findOrCreateCloudUser({
      issuer: ticket.issuer,
      subject: ticket.subject,
      displayName: ticket.displayName,
      username: ticket.username,
      email: ticket.email,
      emailVerified: ticket.emailVerified,
      group: ticket.group,
      affCode: ticket.affCode,
      role: ticket.role,
      ssoCreatedAt: ticket.ssoCreatedAt,
      ssoLastLoginAt: ticket.ssoLastLoginAt,
      ssoAccessToken: ticket.ssoAccessToken,
      ssoRefreshToken: ticket.ssoRefreshToken,
      peachWallet: ticket.peachWallet
    });
    if (user.status !== "ACTIVE") {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Cloud user account is disabled");
    }
    return this.issueDeviceSession(user, txn.deviceLabel || "Campus Cloud Web Console", null, 1, nowMs, "WEB_CONSOLE");
  }

  exchangeMobileTicket({ loginTxn, appTicket, codeVerifier }, nowMs = Date.now()) {
    const ticket = this.store.exchangeTickets.get(appTicket);
    if (!ticket || ticket.loginTxn !== loginTxn || (ticket.flowKind && ticket.flowKind !== "MOBILE_APP")) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Invalid app_ticket or transaction mismatch");
    }
    if (ticket.consumedAtMs !== null) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Single-use app_ticket has already been consumed");
    }
    if (nowMs > ticket.expiresAtMs || nowMs < ticket.issuedAtMs) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Single-use app_ticket expired");
    }
    const txn = this.store.authTransactions.get(loginTxn);
    if (!txn) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Missing login transaction");
    }
    const computedChallenge = computeS256Challenge(codeVerifier || "");
    const expectedChallenge = String(txn.mobileCodeChallenge || "");
    if (
      computedChallenge.length !== expectedChallenge.length ||
      !crypto.timingSafeEqual(Buffer.from(computedChallenge), Buffer.from(expectedChallenge))
    ) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Mobile PKCE code_verifier verification failed");
    }

    ticket.consumedAtMs = nowMs;
    txn.status = "COMPLETED";

    const user = this.store.findOrCreateCloudUser({
      issuer: ticket.issuer,
      subject: ticket.subject,
      displayName: ticket.displayName,
      username: ticket.username,
      email: ticket.email,
      emailVerified: ticket.emailVerified,
      group: ticket.group,
      affCode: ticket.affCode,
      role: ticket.role,
      ssoCreatedAt: ticket.ssoCreatedAt,
      ssoLastLoginAt: ticket.ssoLastLoginAt,
      ssoAccessToken: ticket.ssoAccessToken,
      ssoRefreshToken: ticket.ssoRefreshToken,
      peachWallet: ticket.peachWallet
    });

    if (user.status !== "ACTIVE") {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Cloud user account is disabled");
    }

    return this.issueDeviceSession(user, txn.deviceLabel, null, 1, nowMs, "MOBILE_APP");
  }

  issueDeviceSession(user, deviceLabel, existingFamilyId = null, generation = 1, nowMs = Date.now(), flow = "WEB_CONSOLE") {
    if (!["MOBILE_APP", "WEB_CONSOLE"].includes(flow)) throw new ContractError("BAD_REQUEST", "Unknown session flow");
    // Admin gate applies only to the web-console (backend admin) flow. Mobile app /
    // native client sessions are issued to any authenticated SSO user; admin
    // endpoints are still protected by bearer_rbac role checks downstream.
    if (this.requireAdminAccess && flow === "WEB_CONSOLE" && !this.store.hasAdminAccess?.(user?.id)) {
      throw new ContractError("FORBIDDEN", "仅管理员账号可登录云平台后台");
    }
    const familyId = existingFamilyId || crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const rtPayloadB64 = Buffer.from(
      JSON.stringify({
        sid: sessionId,
        uid: user.id,
        sso_sub: user.subject,
        sso_iss: user.issuer,
        fid: familyId,
        gen: generation,
        dl: deviceLabel || "Android Client",
        exp: Math.floor((nowMs + 30 * 24 * 3600 * 1000) / 1000)
      })
    ).toString("base64url");
    const rtSigB64 = crypto
      .createHmac("sha256", this.sessionSecret)
      .update(rtPayloadB64)
      .digest("base64url");
    const rawRefreshToken = `crs_${rtPayloadB64}.${rtSigB64}`;
    const refreshTokenHash = crypto.createHash("sha256").update(rawRefreshToken).digest("hex");

    const sessionRecord = {
      id: sessionId,
      cloud_user_id: user.id,
      device_label: deviceLabel || "Android Client",
      refresh_token_hash: refreshTokenHash,
      family_id: familyId,
      generation,
      flow,
      expires_at: new Date(nowMs + 30 * 24 * 3600 * 1000).toISOString(),
      revoked_at: null,
      consumed_at: null,
      created_at: new Date(nowMs).toISOString()
    };
    this.store.deviceSessions.set(sessionId, sessionRecord);
    this.store.indexDeviceSession?.(sessionId, sessionRecord);
    if (typeof this.store.saveSnapshot === "function") {
      this.store.saveSnapshot();
    }

    const accessToken = this.signAccessToken({
      sub: user.id,
      familyId,
      sessionId,
      iss: user.issuer,
      ssoSub: user.subject,
      roles: this.store.getUserRoles(user.id),
      nowMs
    });

    const pw = user.peach_wallet || {};
    const peachBalance = Number(pw.peachBalance ?? 0);
    const peachUsed = Number(pw.peachUsed ?? 0);

    return {
      cloud_user_id: user.id,
      access_token: accessToken,
      refresh_token: rawRefreshToken,
      expires_in: 4 * 3600,
      family_id: familyId,
      sso_issuer: user.issuer,
      sso_subject: user.subject,
      username: user.username || user.display_name,
      display_name: user.display_name,
      email: user.email || null,
      email_verified: Boolean(user.email_verified),
      group: user.group || pw.group || "默认分组",
      aff_code: user.aff_code || pw.affCode || null,
      role: user.role || "user",
      peach_balance: peachBalance,
      peach_balance_formatted: pw.peachBalanceFormatted || peachBalance.toFixed(2),
      peach_used: peachUsed,
      peach_used_formatted: pw.peachUsedFormatted || peachUsed.toFixed(2),
      peach_wallet: user.peach_wallet || null
    };
  }

  async syncUserSiteProfileToSso(user, siteDataPatch = {}) {
    if (!user || !user.sso_access_token) {
      return { ok: false, skipped: "no_sso_access_token" };
    }
    try {
      const sanitizedPatch = {};
      if (siteDataPatch && typeof siteDataPatch === "object") {
        for (const [k, v] of Object.entries(siteDataPatch)) {
          if (!SENSITIVE_SITE_DATA_KEYS.has(k)) {
            sanitizedPatch[k] = v;
          }
        }
      }
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${user.sso_access_token}`
      };
      if (this.internalServiceKey) {
        headers["X-Internal-Service-Key"] = this.internalServiceKey;
      }
      const resp = await fetch(`${this.ssoBaseUrl.replace(/\/+$/, "")}/api/internal/user-profile`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          client_id: this.clientId,
          site_short_code: "dis",
          site_data: {
            cloud_user_id: user.id,
            synced_at: new Date().toISOString(),
            ...sanitizedPatch
          }
        }),
        signal: AbortSignal.timeout(this.httpTimeoutMs)
      });
      if (!resp.ok) {
        return { ok: false, status: resp.status };
      }
      return await resp.json().catch(() => ({ ok: true }));
    } catch {
      return { ok: false, skipped: "network_error" };
    }
  }

  async fetchJwksKeys(forceRefresh = false) {
    if (
      !forceRefresh &&
      this._jwksCache &&
      Date.now() < this._jwksCache.expiresAtMs
    ) {
      return this._jwksCache.keys;
    }
    const issuerBase = this.expectedIssuer.replace(/\/+$/, "");
    const discoResp = await fetch(`${issuerBase}/.well-known/openid-configuration`, {
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.httpTimeoutMs)
    });
    if (!discoResp.ok) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "OIDC discovery document unavailable");
    }
    const disco = await discoResp.json();
    if (disco.issuer !== this.expectedIssuer) throw new ContractError("CLOUD_AUTH_REQUIRED", "OIDC discovery issuer mismatch");
    const jwksUri = typeof disco.jwks_uri === "string" ? disco.jwks_uri : "";
    if (!jwksUri.startsWith("https://") || new URL(jwksUri).origin !== new URL(this.expectedIssuer).origin) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "OIDC discovery missing HTTPS jwks_uri");
    }
    const jwksResp = await fetch(jwksUri, {
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(this.httpTimeoutMs)
    });
    if (!jwksResp.ok) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "OIDC JWKS endpoint unavailable");
    }
    const jwks = await jwksResp.json();
    const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
    this._jwksCache = { keys, expiresAtMs: Date.now() + 10 * 60 * 1000 };
    return keys;
  }

  async verifyIdTokenSignature(signingInput, sigB64, header) {
    if (!header || typeof header.kid !== "string" || !header.kid) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token missing key id (kid)");
    }
    if (header.alg !== "RS256" && header.alg !== "ES256") {
      throw new ContractError(
        "CLOUD_AUTH_REQUIRED",
        `Unsupported ID Token signing algorithm: ${header.alg}`
      );
    }
    let keys = await this.fetchJwksKeys();
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      keys = await this.fetchJwksKeys(true);
      jwk = keys.find((k) => k.kid === header.kid);
    }
    if (!jwk) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "No JWKS key matching ID Token kid");
    }
    if ((jwk.alg && jwk.alg !== header.alg) || (jwk.use && jwk.use !== "sig") ||
        (jwk.key_ops && !jwk.key_ops.includes("verify")) ||
        (header.alg === "RS256" && jwk.kty !== "RSA") ||
        (header.alg === "ES256" && (jwk.kty !== "EC" || jwk.crv !== "P-256"))) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "JWKS key is not valid for the ID Token algorithm");
    }
    const keyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const ok =
      header.alg === "RS256"
        ? crypto.verify(
            "RSA-SHA256",
            Buffer.from(signingInput),
            keyObj,
            Buffer.from(sigB64, "base64url")
          )
        : crypto.verify(
            "SHA256",
            Buffer.from(signingInput),
            { key: keyObj, dsaEncoding: "ieee-p1363" },
            Buffer.from(sigB64, "base64url")
          );
    if (!ok) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "ID Token signature verification failed");
    }
  }

  signWebSessionCookie({ cloudUserId, accessToken, refreshToken }) {
    const payload = Buffer.from(
      JSON.stringify({
        uid: cloudUserId,
        at: accessToken,
        rt: refreshToken,
        exp: Math.floor(Date.now() / 1000) + 7 * 86400
      }),
      "utf8"
    );
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sessionSecret, iv);
    cipher.setAAD(Buffer.from("dis-web-session|v2", "utf8"));
    const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v2.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
  }

  verifyWebSessionCookie(cookieHeader, nowMs = Date.now()) {
    if (!cookieHeader || typeof cookieHeader !== "string") return null;
    const m = cookieHeader.match(/(?:^|;\s*)dis_web_session=([^;]+)/);
    if (!m) return null;
    try {
      const raw = decodeURIComponent(m[1].trim());
      const segs = raw.split(".");
      if (segs.length !== 4 || segs[0] !== "v2") return null;
      const iv = Buffer.from(segs[1], "base64url");
      const tag = Buffer.from(segs[2], "base64url");
      const ct = Buffer.from(segs[3], "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.sessionSecret, iv);
      decipher.setAAD(Buffer.from("dis-web-session|v2", "utf8"));
      decipher.setAuthTag(tag);
      const parsed = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
      if (parsed.exp && parsed.exp * 1000 <= nowMs) return null;
      if (!Number.isFinite(parsed.exp) || parsed.exp * 1000 <= nowMs) return null;
      const auth = this.verifyAccessToken(parsed.at, nowMs);
      if (auth.cloudUserId !== parsed.uid) return null;
      const user = this.store.users.get(auth.cloudUserId);
      const session = this.store.deviceSessions.get(auth.sessionId);
      if (session?.flow !== "WEB_CONSOLE" || (this.requireAdminAccess && !this.store.hasAdminAccess?.(user.id))) return null;
      return { user, cloudUserId: user.id, accessToken: parsed.at,
        refreshToken: parsed.rt, roles: auth.roles, familyId: auth.familyId, sessionId: auth.sessionId };
    } catch {
      return null;
    }
  }

  refreshSession(rawRefreshToken, nowMs = Date.now()) {
    if (!rawRefreshToken || typeof rawRefreshToken !== "string") {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Missing refresh_token");
    }
    const hash = crypto.createHash("sha256").update(rawRefreshToken).digest("hex");
    const sessionIdForHash = this.store._idxSessionByRefreshHash?.get(hash);
    const indexedSession = sessionIdForHash ? this.store.deviceSessions.get(sessionIdForHash) : null;
    const session = indexedSession?.refresh_token_hash === hash ? indexedSession : Array.from(this.store.deviceSessions.values()).find(s => s.refresh_token_hash === hash);
    if (!session) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Unknown refresh_token");
    }

    if (session.consumed_at !== null) {
      this.revokeSessionFamily(session.family_id, "REFRESH_TOKEN_REPLAY", nowMs);
      throw new ContractError(
        "SESSION_REPLAY_DETECTED",
        "Refresh token replay detected; entire device session family has been revoked"
      );
    }

    if (session.revoked_at !== null || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= nowMs) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Refresh session expired or revoked");
    }

    const user = this.store.users.get(session.cloud_user_id);
    if (!user || user.status !== "ACTIVE") {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "User account is inactive");
    }

    if (!["MOBILE_APP", "WEB_CONSOLE"].includes(session.flow)) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Unknown session flow; sign in again");
    }
    session.consumed_at = new Date(nowMs).toISOString();
    return this.issueDeviceSession(
      user,
      session.device_label,
      session.family_id,
      session.generation + 1,
      nowMs,
      session.flow
    );
  }

  revokeSessionFamily(familyId, reason = "USER_LOGOUT", nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    // Revocation must cover the full authoritative map, even if a secondary index is stale.
    const targets = this.store.deviceSessions.values();
    for (const s of targets) {
      if (s.family_id === familyId && !s.revoked_at) {
        s.revoked_at = ts;
      }
    }
    this.store.recordAudit({
      actor_kind: "IDENTITY_SERVICE",
      actor_ref: familyId,
      action: "REVOKE_SESSION_FAMILY",
      resource_kind: "cloud_device_session_family",
      resource_ref: familyId,
      outcome: reason
    });
  }

  revokeAllUserSessions(cloudUserId, unlinkXpeach = false, nowMs = Date.now()) {
    const ts = new Date(nowMs).toISOString();
    for (const s of this.store.deviceSessions.values()) {
      if (s.cloud_user_id === cloudUserId && !s.revoked_at) {
        s.revoked_at = ts;
      }
    }
    if (unlinkXpeach === true) {
      this.store.haltAllUserPlansAndBindings(cloudUserId, "XPEACH_UNLINKED", nowMs);
    }
  }

  signAccessToken({ sub, familyId, sessionId, iss, ssoSub, roles, nowMs = Date.now() }) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub,
        family_id: familyId,
        sid: sessionId,
        sso_iss: iss,
        sso_sub: ssoSub,
        roles: roles || [],
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor(nowMs / 1000) + 4 * 3600
      })
    ).toString("base64url");
    const sig = crypto
      .createHmac("sha256", this.sessionSecret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    return `${header}.${payload}.${sig}`;
  }

  verifyAccessToken(bearerToken, nowMs = Date.now()) {
    if (!bearerToken || typeof bearerToken !== "string") {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Missing Bearer access token");
    }
    const parts = bearerToken.split(".");
    if (parts.length !== 3) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Malformed Bearer access token");
    }
    const [headerB64, payloadB64, sigB64] = parts;
    let headerObj;
    try {
      headerObj = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    } catch {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Malformed JWT header");
    }
    if (!headerObj || headerObj.alg !== "HS256") {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Unsupported JWT signing algorithm");
    }
    const expectedSig = crypto
      .createHmac("sha256", this.sessionSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    if (
      sigB64.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sigB64), Buffer.from(expectedSig))
    ) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Invalid access token signature");
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.exp * 1000 <= nowMs) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Access token expired");
    }
    const user = this.store.users.get(payload.sub);
    if (!user || user.status !== "ACTIVE" || !Number.isFinite(payload.exp)) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Cloud user or token is inactive");
    }
    const session = this.store.deviceSessions.get(payload.sid);
    if (!session || session.cloud_user_id !== user.id || session.family_id !== payload.family_id ||
        session.revoked_at !== null || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= nowMs) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Active device session required");
    }
    if (!["MOBILE_APP", "WEB_CONSOLE"].includes(session.flow)) {
      throw new ContractError("CLOUD_AUTH_REQUIRED", "Unknown session flow; sign in again");
    }
    if (this.requireAdminAccess && session.flow === "WEB_CONSOLE" && !this.store.hasAdminAccess?.(user.id)) {
      throw new ContractError("FORBIDDEN", "仅管理员账号可访问云平台后台");
    }
    return {
      cloudUserId: user.id,
      familyId: payload.family_id,
      sessionId: payload.sid,
      ssoIssuer: user.issuer,
      ssoSubject: user.subject,
      roles: this.store.getUserRoles(user.id)
    };
  }
}
