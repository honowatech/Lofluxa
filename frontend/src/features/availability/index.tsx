/** Écran 4 — Disponibilité du jour : stocks dépôt (Supply), camions et chauffeurs (dispatcher). */
import { Lock } from "lucide-react";
import { useSearchParams } from "react-router-dom";

import { Notice, PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fr } from "@/i18n/fr";
import { useCan } from "@/lib/auth/session";
import { formatDateLong } from "@/lib/format";
import { useDay } from "@/lib/useDay";

import { DriversTab } from "./DriversTab";
import { StocksTab } from "./StocksTab";
import { TrucksTab } from "./TrucksTab";

const t = fr.screens.availability;
const TABS = ["stocks", "trucks", "drivers"] as const;
type TabId = (typeof TABS)[number];

export default function AvailabilityPage() {
  const { day } = useDay();
  const canWriteStocks = useCan("availability.stocks.write");
  const canWriteResources = useCan("availability.resources.write");
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  // Par défaut, chacun arrive sur ce qu'il saisit : le dispatcher sur les camions, les autres sur les stocks.
  const fallback: TabId = canWriteResources && !canWriteStocks ? "trucks" : "stocks";
  const tab: TabId = TABS.some((id) => id === requested) ? (requested as TabId) : fallback;
  const canWriteTab = tab === "stocks" ? canWriteStocks : canWriteResources;

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-availability">
      <PageHeader title={fr.nav.screens.availability} subtitle={t.subtitle(formatDateLong(day))} />
      {!canWriteTab && (
        <Notice tone="neutral" icon={<Lock className="size-3.5" />}>
          {!canWriteStocks && !canWriteResources
            ? t.readOnly
            : tab === "stocks"
              ? t.tabReadOnly.stocks
              : t.tabReadOnly.resources}
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
          {TABS.map((id) => (
            <TabsTrigger key={id} value={id}>
              {t.tabs[id]}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* La grille des stocks reste montée : une saisie en cours survit à un changement d'onglet. */}
        <TabsContent value="stocks" forceMount className="min-h-0 flex-1 pt-3 data-[state=inactive]:hidden">
          <StocksTab key={day} day={day} canWrite={canWriteStocks} />
        </TabsContent>
        <TabsContent value="trucks" className="min-h-0 flex-1 pt-3">
          <TrucksTab key={day} day={day} canWrite={canWriteResources} />
        </TabsContent>
        <TabsContent value="drivers" className="min-h-0 flex-1 pt-3">
          <DriversTab key={day} day={day} canWrite={canWriteResources} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
