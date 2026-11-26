import { route } from "./route-table.mjs";

export function createAuthRoutes(ctx) {
  const {
    store,
    identity,
    syncUserToSso
  } = ctx;

  return [
  route(
    "POST",
    "/api/v1/auth/mobile/start",
    "startMobileAuthTransaction",
    "anonymous_rate_limited",
    async ({ body, nowMs }) => {
      const res = identity.startMobileTransaction(
        {
          installEphemeralId: body?.install_ephemeral_id,
          codeChallenge: body?.code_challenge,
          codeChallengeMethod: body?.code_challenge_method,
          deviceLabel: body?.device_label
        },
        nowMs
      );
      return { status: 200, code: "AUTH_TXN_STARTED", data: res };
    }
  ),

  route("GET", "/api/v1/auth/oidc/start", "startOidcRedirect", "login_txn", async ({ query, nowMs }) => {
    const redirectUrl = identity.buildOidcRedirectUrl(query.get("txn"), nowMs);
    return {
      status: 302,
      headers: { Location: redirectUrl },
      code: "OIDC_REDIRECT",
      data: { redirect_url: redirectUrl }
    };
  }),

  route(
    "GET",
    "/api/v1/auth/oidc/callback",
    "handleOidcCallback",
    "oidc_state_nonce",
    async ({ query, nowMs }) => {
      const res = await identity.handleOidcCallback(
        {
          code: query.get("code"),
          state: query.get("state"),
          iss: query.get("iss")
        },
        nowMs
      );
      const headers = { Location: res.appLinkUrl };
      if (res.webSessionCookie) {
        headers["set-cookie"] = `dis_web_session=${encodeURIComponent(
          res.webSessionCookie
        )}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
      }
      return {
        status: 302,
        headers,
        code: "OIDC_CALLBACK_OK",
        data: {
          app_ticket: res.appTicket,
          login_txn: res.loginTxn,
          app_link_url: res.appLinkUrl
        }
      };
    }
  ),

  route(
    "POST",
    "/api/v1/auth/mobile/exchange",
    "exchangeMobileAppTicket",
    "single_use_ticket_and_pkce",
    async ({ body, nowMs }) => {
      const res = identity.exchangeMobileTicket(
        {
          loginTxn: body?.login_txn,
          appTicket: body?.app_ticket,
          codeVerifier: body?.code_verifier
        },
        nowMs
      );
      return { status: 200, code: "SESSION_ISSUED", data: res };
    }
  ),

  route(
    "POST",
    "/api/v1/auth/refresh",
    "refreshCloudSession",
    "refresh_token_family",
    async ({ body, nowMs }) => {
      const res = identity.refreshSession(body?.refresh_token, nowMs);
      return { status: 200, code: "SESSION_REFRESHED", data: res };
    }
  ),

  route("POST", "/api/v1/auth/logout", "logoutCurrentSession", "bearer", async ({ auth, nowMs }) => {
    identity.revokeSessionFamily(auth.familyId, "USER_LOGOUT", nowMs);
    return {
      status: 200,
      code: "LOGGED_OUT",
      data: { family_id: auth.familyId, revoked: true }
    };
  }),

  route("POST", "/api/v1/auth/logout-all", "logoutAllSessions", "bearer", async ({ auth, body, nowMs }) => {
    identity.revokeAllUserSessions(auth.cloudUserId, {
      unlinkXpeach: Boolean(body?.unlink_xpeach),
      reason: Boolean(body?.unlink_xpeach) ? "USER_LOGOUT_ALL_UNLINK" : "USER_LOGOUT_ALL",
      nowMs
    });
    store.flushSnapshotStrictSync?.();
    return {
      status: 200,
      code: "LOGGED_OUT_ALL",
      data: { cloud_user_id: auth.cloudUserId, unlinked_xpeach: Boolean(body?.unlink_xpeach) }
    };
  }),

  route("GET", "/api/v1/auth/web/start", "startWebOidcRedirect", "public", async ({ query, nowMs }) => {
    const rawReturnTo = query.get("return_to") || "/";
    const requestedFlow = String(query.get("flow") || "").trim().toLowerCase();
    const isConsoleTarget =
      requestedFlow === "console" ||
      rawReturnTo === "/console" ||
      rawReturnTo.startsWith("/console/");
    const webTxn = identity.startWebTransaction(
      {
        returnTo: rawReturnTo,
        flowKind: isConsoleTarget ? "WEB_CONSOLE" : "WEB_PORTAL"
      },
      nowMs
    );
    return {
      status: 302,
      headers: { Location: webTxn.redirect_url },
      code: "WEB_OIDC_REDIRECT",
      data: webTxn
    };
  }),

  route("GET", "/api/v1/auth/web/logout", "logoutWebSession", "public", async ({ headers, nowMs }) => {
    const cookieAuth = identity.verifyWebSessionCookie(headers?.cookie || headers?.Cookie || "", nowMs);
    if (cookieAuth?.cloudUserId) {
      // A plain web logout must NEVER unlink the XPeach delegation — only the
      // explicit unlink flow may pass unlinkXpeach: true.
      const sessions = [...store.deviceSessions.values()].filter(session => session.cloud_user_id === cookieAuth.cloudUserId);
      const previousRevocations = sessions.map(session => [session, session.revoked_at]);
      identity.revokeAllUserSessions(cookieAuth.cloudUserId, {
        unlinkXpeach: false,
        reason: "WEB_USER_LOGOUT",
        nowMs
      });
      try {
        store.flushSnapshotStrictSync?.();
      } catch (error) {
        // 确定未发布时恢复原撤销标记，使同 Cookie 可重试；未知提交保持栅栏。
        if (error?.commitPublished === false) {
          for (const [session, revokedAt] of previousRevocations) session.revoked_at = revokedAt;
        }
        throw error;
      }
    }
    return {
      status: 302,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "dis_web_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        Location: "/"
      },
      rawBody: "",
      code: "WEB_LOGGED_OUT",
      data: { logged_out: true }
    };
  }),

  route(
    "POST",
    "/api/v1/auth/web/exchange",
    "exchangeWebAuthTicket",
    "single_use_ticket",
    async ({ body, nowMs }) => {
      const sessionRes = identity.exchangeWebTicket(
        {
          loginTxn: body?.login_txn,
          webTicket: body?.web_ticket
        },
        nowMs
      );
      await syncUserToSso(sessionRes.cloud_user_id);
      const cookieVal = identity.signWebSessionCookie({
        cloudUserId: sessionRes.cloud_user_id,
        accessToken: sessionRes.access_token,
        refreshToken: sessionRes.refresh_token
      });
      return {
        status: 200,
        headers: {
          "set-cookie": `dis_web_session=${encodeURIComponent(
            cookieVal
          )}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
        },
        code: "WEB_SESSION_ISSUED",
        data: sessionRes
      };
    }
  ),

  route("GET", "/api/v1/auth/mobile/status", "getMobileAuthTransactionStatus", "login_txn", async ({ query, nowMs }) => {
    const statusRes = identity.getMobileTransactionStatus(query.get("txn"), nowMs);
    return {
      status: 200,
      code: "AUTH_TXN_STATUS",
      data: statusRes
    };
  }),

  route(
    "POST",
    "/api/v1/auth/oidc/native-login",
    "loginNativeWithSso",
    "anonymous_rate_limited",
    async ({ body, nowMs }) => {
      const nativeRes = await identity.loginNativeWithSso(
        {
          identifier: body?.identifier ?? body?.username ?? body?.email,
          password: body?.password,
          totpCode: body?.totp_code ?? body?.totpCode ?? body?.code,
          installEphemeralId: body?.install_ephemeral_id,
          deviceLabel: body?.device_label
        },
        nowMs
      );
      if (nativeRes.totp_required && !nativeRes.ok) {
        return {
          status: 200,
          code: "TOTP_REQUIRED",
          data: nativeRes
        };
      }
      await syncUserToSso(nativeRes.session.cloud_user_id);
      return {
        status: 200,
        code: "SESSION_ISSUED",
        data: nativeRes.session
      };
    }
  )
  ];
}
