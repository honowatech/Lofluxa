/** Doublures de l'authentification (mode `full` uniquement : en mode `partial`, la vraie API répond). */
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
    const user = readToken(String(body.refresh_token ?? ""), "refresh");
    if (!user) return errorResponse(401, "unauthorized", "Jeton invalide ou expiré.");
    return HttpResponse.json(tokens(user.id));
  }),

  http.post(`${API}/auth/logout`, ({ request }) => {
    const user = authenticate(request);
    return user instanceof Response ? user : new HttpResponse(null, { status: 204 });
  }),

  http.get(`${API}/me`, ({ request }) => {
    const user = authenticate(request);
    if (user instanceof Response) return user;
    return HttpResponse.json({ id: user.id, email: user.email, full_name: user.full_name, role: user.role });
  }),
];
