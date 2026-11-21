/** Écran 10 — Référentiels : produits, dépôts, stations (cuves), camions (compartiments), chauffeurs, transporteurs. */
import { Lock } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Notice, PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fr } from "@/i18n/fr";
import { useCan } from "@/lib/auth/session";

import { CarriersTab } from "./CarriersTab";
import { DepotsTab } from "./DepotsTab";
import { DriversTab } from "./DriversTab";
import { ProductsTab } from "./ProductsTab";
import { StationsTab } from "./StationsTab";
import { TrucksTab } from "./TrucksTab";

const TABS = [
  ["stations", StationsTab],
  ["depots", DepotsTab],
  ["trucks", TrucksTab],
  ["drivers", DriversTab],
  ["products", ProductsTab],
  ["carriers", CarriersTab],
] as const;
type TabId = (typeof TABS)[number][0];

export default function ReferentialsPage() {
  const canWrite = useCan("referentials.write");
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabId = TABS.some(([id]) => id === requested) ? (requested as TabId) : "stations";

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-referentials">
      <PageHeader title={fr.referentials.title} subtitle={fr.referentials.subtitle} />
      {!canWrite && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" />}>
          {fr.referentials.readOnlyNotice}
        </Notice>
      )}
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setParams(
            (current) => {
              const next = new URLSearchParams(current);
              next.set("tab", value);
              return next;
            },
            { replace: true },
          )
        }
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList>
          {TABS.map(([id]) => (
            <TabsTrigger key={id} value={id}>
              {fr.referentials.tabs[id]}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map(([id, Component]) => (
          <TabsContent key={id} value={id} className="min-h-0 flex-1 pt-3">
            <Component canWrite={canWrite} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
