/** Alertes sur les permis et habilitations expirés ou proches de l'expiration (aide visuelle ; RM-03 côté serveur). */
import { useMemo } from "react";

import { expiryState } from "@/components/StatusBadge";
import { fr } from "@/i18n/fr";
import type { AppAlert } from "@/lib/alerts";
import { EXPIRY_WARNING_DAYS } from "@/lib/config";
import { todayLocal } from "@/lib/format";
import type { Driver } from "@/lib/types";

import { drivers } from "./resources";

const t = fr.referentials.drivers;
const PATH = "/referentiels?tab=drivers";

export interface DriverDocumentIssues {
  expired: Driver[];
  soon: Driver[];
}

export function driverDocumentIssues(list: Driver[], today = todayLocal()): DriverDocumentIssues {
  const states = (driver: Driver) => [
    expiryState(driver.license_expiry, today),
    driver.hazmat_cert ? expiryState(driver.hazmat_expiry, today) : "missing",
  ];
  const expired = list.filter((driver) => states(driver).includes("expired"));
  const soon = list.filter((driver) => !expired.includes(driver) && states(driver).includes("soon"));
  return { expired, soon };
}

const names = (list: Driver[]) => list.map((driver) => driver.full_name).join(", ");

export function driverAlerts(issues: DriverDocumentIssues): AppAlert[] {
  const alerts: AppAlert[] = [];
  if (issues.expired.length > 0) {
    alerts.push({
      id: "drivers-expired",
      severity: "blocking",
      title: t.alertExpired(issues.expired.length),
      description: names(issues.expired),
      to: PATH,
    });
  }
  if (issues.soon.length > 0) {
    alerts.push({
      id: "drivers-soon",
      severity: "warning",
      title: t.alertSoon(issues.soon.length, EXPIRY_WARNING_DAYS),
      description: names(issues.soon),
      to: PATH,
    });
  }
  return alerts;
}

/** Charge tous les chauffeurs et calcule les documents à problème. */
export function useDriverDocumentIssues(enabled = true) {
  const query = drivers.useAll({}, { enabled, staleTime: 5 * 60_000 });
  const issues = useMemo(() => driverDocumentIssues(query.data ?? []), [query.data]);
  return { issues, alerts: useMemo(() => driverAlerts(issues), [issues]) };
}
