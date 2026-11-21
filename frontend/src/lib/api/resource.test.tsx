import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { createQueryClient } from "@/app/providers";
import type { Product, ProductInput, StationTank, StationTankInput } from "@/lib/types";
import { db } from "@/mocks/db";
import { loginAs } from "@/test/utils";

import { createChildResource, createResource } from "./resource";

const products = createResource<Product, ProductInput>("/products");
const tanks = createChildResource<StationTank, StationTankInput>("/stations", "tanks");

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
        list: products.useList({ sort: "code" }),
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

  it("sous-ressource : `sync` supprime, crée et ne met à jour que ce qui a changé", async () => {
    loginAs("admin");
    const station = db.stations[0];
    const [a, b, c] = station.tanks;
    await tanks.sync(
      station.id,
      [...station.tanks],
      [
        { id: a.id, product_id: a.product_id, capacity_l: a.capacity_l, safety_stock_l: a.safety_stock_l },
        { id: b.id, product_id: b.product_id, capacity_l: 55000, safety_stock_l: b.safety_stock_l },
        { id: null, product_id: c.product_id, capacity_l: 9000, safety_stock_l: 500 },
      ],
      (existing, next) =>
        existing.capacity_l === next.capacity_l && existing.safety_stock_l === next.safety_stock_l,
    );
    const after = await tanks.list(station.id);
    expect(after.map((tank) => [tank.id === a.id || tank.id === b.id, tank.capacity_l])).toEqual([
      [true, 30000],
      [true, 55000],
      [false, 9000],
    ]);
    expect(after.some((tank) => tank.id === c.id)).toBe(false);
    expect(after[2].product_code).toBe("PETROLE");
  });
});
