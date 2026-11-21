import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { getTokens, setTokens } from "@/lib/auth/tokens";
import { useSession } from "@/lib/auth/session";
import type { Page, Station } from "@/lib/types";
import { db } from "@/mocks/db";
import { API, makeToken, readUpload } from "@/mocks/handlers/helpers";
import { server } from "@/mocks/server";
import { loginAs } from "@/test/utils";

import { api, buildUrl } from "./client";
import { ApiError, errorMessage } from "./errors";
import { apiDownload, apiUpload, filenameFromDisposition } from "./files";
import { fetchAll, pageBounds, pageCount, toListQuery } from "./pagination";

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("une erreur était attendue");
}

describe("client API", () => {
  it("préfixe /api/v1, sérialise la requête et renvoie le JSON typé", async () => {
    loginAs("admin");
    const page = await api<Page<Station>>("/stations", {
      query: { limit: 5, offset: 10, q: "", city: undefined, sort: "code" },
    });
    expect(page.items).toHaveLength(5);
    expect(page).toMatchObject({ total: 30, limit: 5, offset: 10 });
    expect(page.items[0].code).toBe("DLA-011");
    expect(buildUrl("/stations", { a: 1, b: null, c: "", d: ["x", "y"], e: false })).toBe(
      "/api/v1/stations?a=1&d=x&d=y&e=false",
    );
  });

  it("enveloppe d'erreur → ApiError typée (code, message, details, erreurs par champ)", async () => {
    loginAs("admin");
    const error = await caught(
      api("/products", { method: "POST", body: { code: "SUPER", label: "Doublon" } }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("SUPER");
    expect(error.isConflict).toBe(true);
    expect(error.fieldErrors).toEqual({ code: "Valeur déjà utilisée" });
    expect(errorMessage(error)).toBe(error.message);

    const invalid = await caught(api("/products", { method: "POST", body: {} }));
    expect(invalid.status).toBe(422);
    expect(invalid.code).toBe("validation_error");
    expect(Object.keys(invalid.fieldErrors)).toEqual(["code", "label"]);
  });

  it("violations de règle : rule_code RM-xx exposé", async () => {
    loginAs("admin");
    server.use(
      http.post(`${API}/plans/p1/publish`, () =>
        HttpResponse.json(
          {
            code: "rule_violation",
            message: "Le plan contient des violations bloquantes.",
            details: [
              {
                rule_code: "RM-05",
                message: "Compartiment 2 en surcharge",
                severity: "blocking",
                trip_id: "t1",
              },
              { rule_code: "RM-10", message: "Arrivée hors fenêtre", severity: "warning" },
              { rule_code: "RM-05", message: "Compartiment 3 en surcharge" },
            ],
          },
          { status: 409 },
        ),
      ),
    );
    const error = await caught(api("/plans/p1/publish", { method: "POST" }));
    expect(error.rule_code).toBe("RM-05");
    expect(error.ruleCodes).toEqual(["RM-05", "RM-10"]);
    expect(error.violations).toHaveLength(3);
    expect(error.violations[0]).toMatchObject({ rule_code: "RM-05", severity: "blocking", trip_id: "t1" });
    expect(error.violations[2].severity).toBe("blocking");
  });

  it("204 → undefined ; réponse non JSON et panne réseau → messages en français", async () => {
    loginAs("admin");
    server.use(
      http.delete(`${API}/things/1`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${API}/broken`, () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })),
      http.get(`${API}/offline`, () => HttpResponse.error()),
    );
    await expect(api("/things/1", { method: "DELETE" })).resolves.toBeUndefined();
    const broken = await caught(api("/broken"));
    expect(broken.status).toBe(502);
    expect(broken.message).toMatch(/serveur a rencontré une erreur/);
    const offline = await caught(api("/offline"));
    expect(offline.isNetwork).toBe(true);
    expect(offline.code).toBe("network_error");
  });

  it("401 : rafraîchit le jeton une seule fois pour des appels simultanés, puis rejoue", async () => {
    const user = loginAs("admin");
    setTokens({
      access_token: makeToken("access", user.id, -1000),
      refresh_token: makeToken("refresh", user.id),
    });
    const refreshes = vi.fn();
    server.events.on("request:start", ({ request }) => {
      if (request.url.endsWith("/auth/refresh")) refreshes();
    });
    const [a, b, c] = await Promise.all([
      api<Page<Station>>("/stations", { query: { limit: 1 } }),
      api<Page<unknown>>("/depots"),
      api<{ email: string }>("/me"),
    ]);
    server.events.removeAllListeners();
    expect(a.total).toBe(30);
    expect(b.total).toBe(3);
    expect(c.email).toBe("admin@honowa.tech");
    expect(refreshes).toHaveBeenCalledTimes(1);
    expect(getTokens()?.access_token).not.toContain(".-");
    expect(useSession.getState().status).toBe("authenticated");
  });

  it("401 sans rafraîchissement possible : session fermée et marquée expirée", async () => {
    const user = loginAs("admin");
    setTokens({
      access_token: makeToken("access", user.id, -1000),
      refresh_token: makeToken("refresh", user.id, -1000),
    });
    const error = await caught(api("/stations"));
    expect(error.code).toBe("session_expired");
    expect(getTokens()).toBeNull();
    expect(useSession.getState()).toMatchObject({ status: "anonymous", user: null, expired: true });
  });

  it("403 : le rôle ne permet pas l'écriture", async () => {
    loginAs("manager");
    const error = await caught(api("/products", { method: "POST", body: { code: "X", label: "Y" } }));
    expect(error.isForbidden).toBe(true);
    expect(error.message).toBe("Votre rôle ne permet pas cette action.");
  });

  it("connexion : identifiants refusés (route publique, pas de rafraîchissement)", async () => {
    await expect(useSession.getState().login("admin@honowa.tech", "faux")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    expect(useSession.getState().status).toBe("anonymous");
    const me = await useSession.getState().login("ADMIN@honowa.tech", "admin-dev-only");
    expect(me.role).toBe("admin");
    await useSession.getState().logout();
    expect(getTokens()).toBeNull();
  });
});

describe("fichiers", () => {
  it("téléchargement : nom de fichier de Content-Disposition", async () => {
    loginAs("admin");
    const file = await apiDownload("/imports/templates/stations");
    expect(file.filename).toBe("modele_stations.csv");
    expect(file.blob.size).toBeGreaterThan(20);
    expect(filenameFromDisposition("attachment; filename*=UTF-8''feuille%20de%20route.pdf")).toBe(
      "feuille de route.pdf",
    );
    expect(filenameFromDisposition('inline; filename="fiche.pdf"')).toBe("fiche.pdf");
    expect(filenameFromDisposition(null)).toBeNull();
  });

  it("envoi multipart : champ `file` + champs simples", async () => {
    loginAs("admin");
    let received: { name: string; day: string; text: string } | null = null;
    server.use(
      http.post(`${API}/upload-test`, async ({ request }) => {
        const upload = await readUpload(request);
        received = { name: upload.files.file.name, day: upload.fields.day, text: upload.files.file.text };
        return HttpResponse.json({ ok: true });
      }),
    );
    const file = new File(["code;name\nA;Bépanda\n"], "stations.csv", { type: "text/csv" });
    await expect(
      apiUpload<{ ok: boolean }>("/upload-test", file, { fields: { day: "2027-01-12" } }),
    ).resolves.toEqual({ ok: true });
    expect(received).toEqual({ name: "stations.csv", day: "2027-01-12", text: "code;name\nA;Bépanda\n" });
  });
});

describe("pagination", () => {
  it("toListQuery : limit / offset / sort / q / filtres", () => {
    expect(
      toListQuery({
        pageIndex: 2,
        pageSize: 25,
        sorting: [{ id: "code", desc: true }],
        search: " akwa ",
        filters: { active: "true", city: "" },
      }),
    ).toEqual({
      limit: 25,
      offset: 50,
      sort: "-code",
      q: "akwa",
      active: "true",
    });
    expect(toListQuery({})).toEqual({ limit: 50, offset: 0 });
  });

  it("bornes et nombre de pages", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(101, 50)).toBe(3);
    expect(pageBounds({ total: 132, limit: 50, offset: 100 })).toEqual({ from: 101, to: 132 });
    expect(pageBounds({ total: 0, limit: 50, offset: 0 })).toEqual({ from: 0, to: 0 });
  });

  it("fetchAll parcourt toutes les pages", async () => {
    loginAs("admin");
    const calls: string[] = [];
    server.use(
      http.get(`${API}/numbers`, ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        calls.push(String(offset));
        const all = Array.from({ length: 1200 }, (_, i) => ({ id: String(i) }));
        return HttpResponse.json({
          items: all.slice(offset, offset + 500),
          total: all.length,
          limit: 500,
          offset,
        });
      }),
    );
    const items = await fetchAll<{ id: string }>("/numbers");
    expect(items).toHaveLength(1200);
    expect(calls).toEqual(["0", "500", "1000"]);
    expect(db.stations).toHaveLength(30);
  });
});
