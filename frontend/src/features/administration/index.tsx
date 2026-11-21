/** Écran 11 — Administration : utilisateurs (F9.1), paramètres (F9.2), journal d'audit (F9.3). */
import { useSearchParams } from "react-router-dom";

import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fr } from "@/i18n/fr";

import { AuditTab } from "./AuditTab";
import { SettingsTab } from "./SettingsTab";
import { UsersTab } from "./UsersTab";

const TABS = [
  ["users", UsersTab],
  ["settings", SettingsTab],
  ["audit", AuditTab],
] as const;
type TabId = (typeof TABS)[number][0];

export default function AdministrationPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabId = TABS.some(([id]) => id === requested) ? (requested as TabId) : "users";

  return (
    <div className="flex h-full flex-col gap-3 p-4" data-testid="screen-administration">
      <PageHeader title={fr.administration.title} subtitle={fr.administration.subtitle} />
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
              {fr.administration.tabs[id]}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map(([id, Component]) => (
          <TabsContent key={id} value={id} className="min-h-0 flex-1 pt-3">
            <Component />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
