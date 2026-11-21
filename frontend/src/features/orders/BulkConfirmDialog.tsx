/** Résultat de la confirmation en masse (`POST /orders/confirm`) : une ligne par commande. */
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fr } from "@/i18n/fr";

import type { BulkConfirmResult } from "./api";

const t = fr.screens.orders.bulk;

export interface BulkReport {
  result: BulkConfirmResult;
  /** Libellé de chaque commande envoyée (la réponse ne porte pas la commande quand elle est refusée). */
  labels: Record<string, string>;
  /** Commandes de la sélection écartées avant l'envoi (elles n'étaient pas en brouillon). */
  ignored: number;
}

export function BulkConfirmDialog({ report, onClose }: { report: BulkReport | null; onClose: () => void }) {
  return (
    <Dialog open={report !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" data-testid="bulk-confirm-report">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>
            {report && t.summary(report.result.confirmed, report.result.failed)}
            {report && report.ignored > 0 && ` ${t.ignored(report.ignored)}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="p-0">
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr>
                {[t.order, t.result, t.detail].map((header) => (
                  <th
                    key={header}
                    scope="col"
                    className="sticky top-0 border-b bg-muted px-3 py-1.5 text-left text-xs font-semibold text-foreground/70"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(report?.result.results ?? []).map((item) => {
                const warned = item.ok && item.warnings.length > 0;
                const Icon = !item.ok ? CircleAlert : warned ? TriangleAlert : CircleCheck;
                return (
                  <tr key={item.order_id} data-ok={item.ok} className="align-top">
                    <td className="border-b px-3 py-1.5">
                      {report?.labels[item.order_id] ?? t.unknownOrder}
                    </td>
                    <td className="whitespace-nowrap border-b px-3 py-1.5">
                      <span
                        className={
                          !item.ok
                            ? "flex items-center gap-1 font-medium text-blocking"
                            : warned
                              ? "flex items-center gap-1 font-medium text-warning"
                              : "flex items-center gap-1 text-success"
                        }
                      >
                        <Icon className="size-3.5" aria-hidden />
                        {!item.ok ? t.refused : warned ? t.okWithWarning : t.ok}
                      </span>
                    </td>
                    <td className="border-b px-3 py-1.5 text-xs leading-snug">
                      {item.error?.message}
                      {item.warnings.map((warning) => (
                        <p key={warning.code}>{warning.message}</p>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>{t.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
