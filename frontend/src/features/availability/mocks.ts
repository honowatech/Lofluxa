/**
 * Doublures MSW de l'écran Disponibilité du jour (routes du lot L4), avec un petit jeu autonome et stable :
 * 2 dépôts × 3 produits, 5 camions, 6 chauffeurs. Les règles du serveur réel sont reproduites : historique des
 * stocks (une ligne par valeur modifiée), affectabilité RM-03 / RM-04, conflit 409 d'affectation.
 * À brancher par `server.use(...createAvailabilityMocks().handlers)`.
 */
import { http, HttpResponse, type HttpHandler } from "msw";

import { API, authenticate, authorize, errorResponse, notFound } from "@/mocks/handlers/helpers";

import type {
  DepotStockEntry,
  DepotStockItem,
  DriverDay,
  DriverDayItem,
  TruckDay,
  TruckDayItem,
} from "./api";

export const MOCK_DAY = "2027-01-12";

const DEPOTS = [
  { id: "dep-dla", code: "SCDP-DLA", name: "SCDP Douala" },
  { id: "dep-yde", code: "SCDP-YDE", name: "SCDP Yaoundé" },
];
const PRODUCTS = [
  { id: "prod-gasoil", code: "GASOIL", label: "Gasoil" },
  { id: "prod-petrole", code: "PETROLE", label: "Pétrole lampant" },
  { id: "prod-super", code: "SUPER", label: "Super" },
];

interface MockTruck {
  id: string;
  plate: string;
  size: TruckDay["size"];
  total_capacity_l: number;
  carrier_name: string;
  status: TruckDay["status"];
}
interface MockDriver {
  id: string;
  full_name: string;
  carrier_name: string;
  status: DriverDay["status"];
  license_expiry: string;
  hazmat_expiry: string;
  default_truck_id: string | null;
}

const TRUCKS: MockTruck[] = [
  {
    id: "t1",
    plate: "LT-401-AA",
    size: "medium",
    total_capacity_l: 25000,
    carrier_name: "OLA Flotte",
    status: "available",
  },
  {
    id: "t2",
    plate: "LT-402-AB",
    size: "medium",
    total_capacity_l: 25000,
    carrier_name: "OLA Flotte",
    status: "available",
  },
  {
    id: "t3",
    plate: "LT-403-AC",
    size: "small",
    total_capacity_l: 13000,
    carrier_name: "OLA Flotte",
    status: "available",
  },
  {
    id: "t4",
    plate: "LT-456-CD",
    size: "small",
    total_capacity_l: 12000,
    carrier_name: "Sotracam",
    status: "maintenance",
  },
  {
    id: "t5",
    plate: "LT-777-ZZ",
    size: "large",
    total_capacity_l: 24000,
    carrier_name: "Sotracam",
    status: "broken",
  },
];
const VALID = { license_expiry: "2028-06-30", hazmat_expiry: "2027-12-31" };
const DRIVERS: MockDriver[] = [
  {
    id: "d1",
    full_name: "Roger Abega",
    carrier_name: "OLA Flotte",
    status: "available",
    ...VALID,
    default_truck_id: "t1",
  },
  {
    id: "d2",
    full_name: "Alain Nkoulou",
    carrier_name: "OLA Flotte",
    status: "available",
    ...VALID,
    default_truck_id: "t2",
  },
  {
    id: "d3",
    full_name: "Yves Mbarga",
    carrier_name: "OLA Flotte",
    status: "available",
    ...VALID,
    default_truck_id: null,
  },
  {
    id: "d4",
    full_name: "Samuel Etoga",
    carrier_name: "OLA Flotte",
    status: "available",
    license_expiry: "2026-12-31",
    hazmat_expiry: "2027-08-31",
    default_truck_id: null,
  },
  {
    id: "d5",
    full_name: "Blaise Nkono",
    carrier_name: "Sotracam",
    status: "available",
    license_expiry: "2028-02-28",
    hazmat_expiry: "2027-01-05",
    default_truck_id: null,
  },
  {
    id: "d6",
    full_name: "Aline Fotso",
    carrier_name: "Sotracam",
    status: "leave",
    ...VALID,
    default_truck_id: null,
  },
];

const frDate = (iso: string) => iso.split("-").reverse().join("/");

export function createAvailabilityMocks() {
  let counter = 0;
  const entry = (
    depotId: string,
    productId: string,
    available_l: number | null,
    entered_at: string,
    author: string,
  ) => ({
    id: `stock-${(counter += 1)}`,
    depot_id: depotId,
    product_id: productId,
    available_l,
    entered_at,
    entered_by_name: author,
  });

  const state = {
    /** Historique complet des saisies (la plus récente de chaque couple fait foi). */
    entries: [
      entry("dep-dla", "prod-gasoil", 110000, "2027-01-12T04:55:00Z", "Hervé Mbah"),
      entry("dep-dla", "prod-gasoil", 120000, "2027-01-12T05:10:00Z", "Hervé Mbah"),
    ],
    truckMarks: {} as Record<string, string | null>,
    driverMarks: {} as Record<string, string | null>,
    /** Affectations du jour : chauffeur → camion. */
    daily: {} as Record<string, string>,
    stockPuts: [] as DepotStockItem[][],
    truckPuts: [] as TruckDayItem[][],
    driverPuts: [] as DriverDayItem[][],
  };

  const current = (depotId: string, productId: string) =>
    state.entries.filter((e) => e.depot_id === depotId && e.product_id === productId).at(-1);

  const stockRows = () =>
    DEPOTS.flatMap((depot) =>
      PRODUCTS.map((product) => {
        const last = current(depot.id, product.id);
        return {
          id: last?.id ?? null,
          day: MOCK_DAY,
          depot_id: depot.id,
          depot_code: depot.code,
          depot_name: depot.name,
          product_id: product.id,
          product_code: product.code,
          product_label: product.label,
          available_l: last?.available_l ?? null,
          entered_at: last?.entered_at ?? null,
          entered_by: last ? "user" : null,
          entered_by_name: last?.entered_by_name ?? null,
          history_count: state.entries.filter((e) => e.depot_id === depot.id && e.product_id === product.id)
            .length,
        };
      }),
    );

  const truckReason = (truck: MockTruck): string | null => {
    if (truck.status === "maintenance") return "Camion en maintenance.";
    if (truck.status === "broken") return "Camion en panne.";
    if (truck.status === "reserved") return "Camion réservé.";
    if (truck.id in state.truckMarks) {
      const reason = state.truckMarks[truck.id];
      return `Camion marqué indisponible pour la journée${reason ? ` : ${reason}` : ""}.`;
    }
    return null;
  };

  const rm03 = (driver: MockDriver): string | null => {
    if (driver.license_expiry < MOCK_DAY)
      return `Permis de conduire expiré depuis le ${frDate(driver.license_expiry)}.`;
    if (driver.hazmat_expiry < MOCK_DAY)
      return `Habilitation matières dangereuses expirée depuis le ${frDate(driver.hazmat_expiry)}.`;
    return null;
  };
  const driverReason = (driver: MockDriver): string | null => {
    const blocking = rm03(driver);
    if (blocking) return blocking;
    if (driver.status !== "available") return "Chauffeur en congé.";
    if (driver.id in state.driverMarks) {
      const reason = state.driverMarks[driver.id];
      return `Chauffeur marqué indisponible pour la journée${reason ? ` : ${reason}` : ""}.`;
    }
    return null;
  };

  /** Camion du jour d'un chauffeur : l'affectation du jour fait foi, sinon le camion habituel s'il est libre. */
  const truckOf = (driver: MockDriver): { id: string; source: "daily" | "default" } | null => {
    if (state.daily[driver.id]) return { id: state.daily[driver.id], source: "daily" };
    const usual = driver.default_truck_id;
    if (usual && !Object.values(state.daily).includes(usual) && !driverReason(driver))
      return { id: usual, source: "default" };
    return null;
  };

  const driverRows = (): DriverDay[] =>
    DRIVERS.map((driver) => {
      const reason = driverReason(driver);
      const truck = truckOf(driver);
      return {
        driver_id: driver.id,
        day: MOCK_DAY,
        full_name: driver.full_name,
        phone: null,
        carrier_id: null,
        carrier_name: driver.carrier_name,
        status: driver.status,
        license_expiry: driver.license_expiry,
        hazmat_cert: true,
        hazmat_expiry: driver.hazmat_expiry,
        available_today: !(driver.id in state.driverMarks),
        day_reason: state.driverMarks[driver.id] ?? null,
        assignable: reason === null,
        block_reason: reason,
        rule_code: rm03(driver) ? "RM-03" : null,
        default_truck_id: driver.default_truck_id,
        default_truck_plate: TRUCKS.find((t) => t.id === driver.default_truck_id)?.plate ?? null,
        truck_id: truck?.id ?? null,
        truck_plate: TRUCKS.find((t) => t.id === truck?.id)?.plate ?? null,
        assignment_source: truck?.source ?? null,
      };
    });

  const truckRows = (): TruckDay[] =>
    TRUCKS.map((truck) => {
      const reason = truckReason(truck);
      const driver = driverRows().find((row) => row.truck_id === truck.id);
      return {
        truck_id: truck.id,
        day: MOCK_DAY,
        plate: truck.plate,
        size: truck.size,
        total_capacity_l: truck.total_capacity_l,
        carrier_id: null,
        carrier_name: truck.carrier_name,
        status: truck.status,
        available_today: !(truck.id in state.truckMarks),
        day_reason: state.truckMarks[truck.id] ?? null,
        assignable: reason === null,
        block_reason: reason,
        rule_code: reason === null ? null : "RM-04",
        driver_id: driver?.driver_id ?? null,
        driver_name: driver?.full_name ?? null,
        assignment_source: driver?.assignment_source ?? null,
      };
    });

  const page = <T>(items: T[]) => HttpResponse.json({ items, total: items.length, limit: 500, offset: 0 });

  const handlers: HttpHandler[] = [
    http.get(`${API}/availability/depot-stocks/history`, ({ request }) => {
      const user = authenticate(request);
      if (user instanceof Response) return user;
      const params = new URL(request.url).searchParams;
      const items: DepotStockEntry[] = state.entries
        .filter(
          (e) =>
            (!params.get("depot_id") || e.depot_id === params.get("depot_id")) &&
            (!params.get("product_id") || e.product_id === params.get("product_id")),
        )
        .map((e) => {
          const depot = DEPOTS.find((d) => d.id === e.depot_id) as (typeof DEPOTS)[number];
          const product = PRODUCTS.find((p) => p.id === e.product_id) as (typeof PRODUCTS)[number];
          return {
            id: e.id,
            day: MOCK_DAY,
            depot_id: depot.id,
            depot_code: depot.code,
            depot_name: depot.name,
            product_id: product.id,
            product_code: product.code,
            product_label: product.label,
            available_l: e.available_l,
            entered_at: e.entered_at,
            entered_by: "user",
            entered_by_name: e.entered_by_name,
            is_current: current(e.depot_id, e.product_id)?.id === e.id,
          };
        })
        .reverse();
      return page(items);
    }),
    http.get(`${API}/availability/depot-stocks`, ({ request }) => {
      const user = authenticate(request);
      return user instanceof Response ? user : page(stockRows());
    }),
    http.put(`${API}/availability/depot-stocks`, async ({ request }) => {
      const user = authorize(request, ["supply"]);
      if (user instanceof Response) return user;
      const { items } = (await request.json()) as { items: DepotStockItem[] };
      state.stockPuts.push(items);
      for (const item of items) {
        if (!DEPOTS.some((depot) => depot.id === item.depot_id)) return notFound("Dépôt");
        // Comme le serveur : une saisie identique à la valeur courante n'ajoute pas de ligne (L4-12).
        if (current(item.depot_id, item.product_id)?.available_l === item.available_l) continue;
        state.entries.push(
          entry(item.depot_id, item.product_id, item.available_l, "2027-01-12T05:42:00Z", user.full_name),
        );
      }
      const touched = new Set(items.map((item) => `${item.depot_id}:${item.product_id}`));
      return HttpResponse.json(stockRows().filter((row) => touched.has(`${row.depot_id}:${row.product_id}`)));
    }),

    http.get(`${API}/availability/trucks`, ({ request }) => {
      const user = authenticate(request);
      return user instanceof Response ? user : page(truckRows());
    }),
    http.put(`${API}/availability/trucks`, async ({ request }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const { items } = (await request.json()) as { items: TruckDayItem[] };
      state.truckPuts.push(items);
      for (const item of items) {
        if (item.available) delete state.truckMarks[item.truck_id];
        else state.truckMarks[item.truck_id] = item.reason ?? null;
      }
      return HttpResponse.json(truckRows().filter((row) => items.some((i) => i.truck_id === row.truck_id)));
    }),

    http.get(`${API}/availability/drivers`, ({ request }) => {
      const user = authenticate(request);
      return user instanceof Response ? user : page(driverRows());
    }),
    http.put(`${API}/availability/drivers`, async ({ request }) => {
      const user = authorize(request, ["dispatcher"]);
      if (user instanceof Response) return user;
      const { items } = (await request.json()) as { items: DriverDayItem[] };
      state.driverPuts.push(items);
      for (const item of items) {
        if (item.available === true) delete state.driverMarks[item.driver_id];
        else if (item.available === false) state.driverMarks[item.driver_id] = item.reason ?? null;
      }
      const changes = items.filter((item) => "truck_id" in item);
      const daily = { ...state.daily };
      // Les lignes des chauffeurs concernés sont d'abord libérées : un échange tient en une seule saisie.
      for (const item of changes) delete daily[item.driver_id];
      for (const item of changes) {
        if (!item.truck_id) continue;
        const driver = DRIVERS.find((d) => d.id === item.driver_id) as MockDriver;
        const truck = TRUCKS.find((t) => t.id === item.truck_id) as MockTruck;
        const holder = Object.entries(daily).find(([, truckId]) => truckId === truck.id)?.[0];
        if (holder) {
          const other = DRIVERS.find((d) => d.id === holder) as MockDriver;
          return errorResponse(
            409,
            "truck_already_assigned",
            `Le camion ${truck.plate} est déjà affecté à ${other.full_name} pour cette journée.`,
            [{ truck_id: truck.id, driver_id: holder, day: MOCK_DAY }],
          );
        }
        const blocked = rm03(driver);
        if (blocked) {
          return errorResponse(
            409,
            "rule_violation",
            `${driver.full_name} n'est pas affectable : ${blocked}`,
            [{ rule_code: "RM-03", message: blocked, driver_id: driver.id }],
          );
        }
        const truckBlocked = truckReason(truck);
        if (truckBlocked) {
          return errorResponse(
            409,
            "rule_violation",
            `Le camion ${truck.plate} n'est pas affectable : ${truckBlocked}`,
            [{ rule_code: "RM-04", message: truckBlocked, truck_id: truck.id }],
          );
        }
        daily[item.driver_id] = truck.id;
      }
      state.daily = daily;
      return HttpResponse.json(
        driverRows().filter((row) => items.some((i) => i.driver_id === row.driver_id)),
      );
    }),
  ];

  return { state, handlers };
}
