/**
 * Doublures de l'authentification (mode `full` uniquement : en mode `partial`, la vraie API répond).
 * Fidèles au lot L8 : rotation du jeton de rafraîchissement (un jeton ne sert qu'une fois), déconnexion
 * qui révoque le jeton de rafraîchissement transmis.
 */
import { http, HttpResponse } from "msw";

import { db } from "../db";
import { API, authenticate, errorResponse, makeToken, readJson, readToken, wait } from "./helpers";

const tokens = (userId: string) => ({
  access_token: makeToken("access", userId),
  refresh_token: makeToken("refresh", userId),
  token_type: "bearer",
});

export const authHandlers = [
  http.post(`${API}/auth/login`, async ({ request }) => {
    await wait();
    const body = await readJson(request);
    const email = String(body.email ?? "").toLowerCase();
    const user = db.users.find((u) => u.email === email);
    if (!user || !user.active || user.password !== body.password) {
      return errorResponse(401, "invalid_credentials", "E-mail ou mot de passe incorrect.");
    }
    user.last_login_at = new Date().toISOString();
    return HttpResponse.json(tokens(user.id));
  }),

  http.post(`${API}/auth/refresh`, async ({ request }) => {
    const body = await readJson(request);
    const token = String(body.refresh_token ?? "");
    if (db.revokedTokens.has(token))
      return errorResponse(401, "token_revoked", "Session terminée. Reconnectez-vous.");
    const user = readToken(token, "refresh");
    if (!user) return errorResponse(401, "unauthorized", "Jeton invalide ou expiré.");
    db.revokedTokens.add(token);
    return HttpResponse.json(tokens(user.id));
  }),

  http.post(`${API}/auth/logout`, async ({ request }) => {
    const user = authenticate(request);
    if (user instanceof Response) return user;
    const body = await readJson(request);
    if (typeof body.refresh_token === "string") db.revokedTokens.add(body.refresh_token);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/me`, ({ request }) => {
    const user = authenticate(request);
    if (user instanceof Response) return user;
    return HttpResponse.json({ id: user.id, email: user.email, full_name: user.full_name, role: user.role });
  }),
];
