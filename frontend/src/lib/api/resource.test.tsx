import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/app/providers";
import type { Product, ProductInput } from "@/lib/types";
import { db } from "@/mocks/db";
import { loginAs } from "@/test/utils";

import { createResource } from "./resource";

const products = createResource<Product, ProductInput>("/products");

function wrapper() {
  const client = createQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("createResource — hooks CRUD génériques", () => {
  it("liste, création, mise à jour, suppression : les listes se rafraîchissent après chaque écriture", async () => {
    loginAs("admin");
    const { result } = renderHook(
      () => ({
        list: products.useList(),
        all: products.useAll(),
        create: products.useCreate(),
        update: products.useUpdate(),
        remove: products.useRemove(),
      }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.list.data?.total).toBe(3));
    expect(result.current.list.data?.items.map((p) => p.code)).toEqual(["GASOIL", "PETROLE", "SUPER"]);

    let created: Product | undefined;
    await act(async () => {
      created = await result.current.create.mutateAsync({
        code: "JET",
        label: "Jet A1",
        ref_density_15: 0.8,
        thermal_coeff: 0.0009,
        color: "#333333",
      });
    });
    expect(created?.id).toBeTruthy();
    await waitFor(() => expect(result.current.list.data?.total).toBe(4));
    await waitFor(() => expect(result.current.all.data).toHaveLength(4));

    await act(async () => {
      // Mise à jour partielle : seul le champ envoyé change.
      await result.current.update.mutateAsync({ id: created?.id as string, input: { label: "Jet A-1" } });
    });
    await waitFor(() =>
      expect(result.current.list.data?.items.find((p) => p.code === "JET")?.label).toBe("Jet A-1"),
    );

    await act(async () => {
      await result.current.remove.mutateAsync(created?.id as string);
    });
    await waitFor(() => expect(result.current.list.data?.total).toBe(3));
  });

  it("erreur typée exposée par le hook ; détail par identifiant", async () => {
    loginAs("manager");
    const id = db.products[0].id;
    const { result } = renderHook(
      () => ({ one: products.useOne(id), missing: products.useOne("inconnu"), create: products.useCreate() }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.one.data?.code).toBe("SUPER"));
    await waitFor(() => expect(result.current.missing.error?.isNotFound).toBe(true));
    await act(async () => {
      await result.current.create
        .mutateAsync({ code: "X", label: "Y", ref_density_15: 1, thermal_coeff: 0, color: "#000000" })
        .catch(() => undefined);
    });
    await waitFor(() => expect(result.current.create.error?.isForbidden).toBe(true));
  });
});
