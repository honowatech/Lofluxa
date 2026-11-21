import type { ReactNode } from "react";

import { MapView, type MapPoint } from "@/components/map";
import { fr } from "@/i18n/fr";
import { CARRIER_TYPES, DEPOT_OPERATORS, DRIVER_STATUSES, TRUCK_SIZES, TRUCK_STATUSES } from "@/lib/types";

/** Listes de choix dérivées des énumérations. */
export const options = {
  truckSize: TRUCK_SIZES.map((value) => ({ value, label: fr.status.size[value] })),
  truckStatus: TRUCK_STATUSES.map((value) => ({ value, label: fr.status.truck[value] })),
  driverStatus: DRIVER_STATUSES.map((value) => ({ value, label: fr.status.driver[value] })),
  operator: DEPOT_OPERATORS.map((value) => ({ value, label: fr.status.operator[value] })),
  carrierType: CARRIER_TYPES.map((value) => ({ value, label: fr.status.carrierType[value] })),
  active: [
    { value: "true", label: fr.common.active },
    { value: "false", label: fr.common.inactive },
  ],
};

/** Tableau à gauche, carte à droite (stations, dépôts). */
export function TableWithMap({
  table,
  points,
  selectedId,
  onSelect,
  label,
}: {
  table: ReactNode;
  points: MapPoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,30%)]">
      <div className="min-h-0">{table}</div>
      <MapView
        points={points}
        selectedId={selectedId}
        onSelect={(id) => onSelect(id)}
        label={label}
        legend
        className="hidden h-full min-h-64 xl:flex"
      />
    </div>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <span className="num">{children}</span>;
export const Muted = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);
