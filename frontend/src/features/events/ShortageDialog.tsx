/** Déclaration d'une pénurie produit au dépôt par Supply (F6.3) : mise à jour du stock, tournées impactées. */
import { ArrowRight } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { NumberInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { ErrorState, LoadingState, Spinner } from "@/components/states";
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
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fr } from "@/i18n/fr";
import type { IsoDate } from "@/lib/types";

import { ApiErrorNotice } from "./ApiErrorNotice";
import { EventTimeField, parseEventTime } from "./EventTime";
import { useDepots, useProductShortage, useProducts, type ShortageOut } from "./api";
import { ShortageOverview } from "./ImpactDialog";

const t = fr.screens.events.shortage;

export function ShortageDialog({
  day,
  open,
  onOpenChange,
  onResolve,
}: {
  day: IsoDate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fourni si l'utilisateur peut aussi traiter la pénurie (dispatcher, admin). */
  onResolve?: (eventId: string) => void;
}) {
  const ids = useId();
  const depots = useDepots(open);
  const products = useProducts(open);
  const shortage = useProductShortage();
  const [depotId, setDepotId] = useState("");
  const [productId, setProductId] = useState("");
  const [liters, setLiters] = useState<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [time, setTime] = useState("");
  const eventTime = parseEventTime(day, time);
  const [declared, setDeclared] = useState<ShortageOut | null>(null);

  const reset = () => {
    setDepotId("");
    setProductId("");
    setLiters(null);
    setInvalid(false);
    setTime("");
    setDeclared(null);
    shortage.reset();
  };
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activeDepots = (depots.data ?? []).filter((depot) => depot.active);
  const error = shortage.error;

  const submit = async () => {
    if (!depotId || !productId || liters === null || liters < 0 || !eventTime.valid) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    try {
      setDeclared(
        await shortage.mutateAsync({
          depot_id: depotId,
          product_id: productId,
          new_available_l: liters,
          day,
          ...(eventTime.occurredAt ? { occurred_at: eventTime.occurredAt } : {}),
        }),
      );
      notify.success(t.done.toast);
    } catch {
      // L'erreur est affichée dans la boîte (état de la mutation).
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" aria-describedby={`${ids}-description`}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription id={`${ids}-description`}>{t.description}</DialogDescription>
        </DialogHeader>

        {declared ? (
          <>
            <DialogBody className="flex flex-col gap-3">
              <p className="text-sm font-medium">{t.done.title}</p>
              <ShortageOverview shortage={declared} />
              <p className="text-sm">
                {declared.impacted_trips.length === 0 ? t.done.none : t.done.toResolve}
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" className="mr-auto" onClick={reset}>
                {t.done.another}
              </Button>
              <Button
                variant={onResolve && declared.status === "open" ? "outline" : "default"}
                onClick={() => onOpenChange(false)}
              >
                {fr.common.close}
              </Button>
              {onResolve && declared.status === "open" && (
                <Button
                  onClick={() => {
                    onOpenChange(false);
                    onResolve(declared.event.id);
                  }}
                >
                  {fr.screens.events.feed.resolve}
                  <ArrowRight aria-hidden />
                </Button>
              )}
            </DialogFooter>
          </>
        ) : depots.isLoading || products.isLoading ? (
          <DialogBody>
            <LoadingState compact />
          </DialogBody>
        ) : depots.error || products.error ? (
          <DialogBody>
            <ErrorState
              compact
              error={depots.error ?? products.error}
              onRetry={() => {
                void depots.refetch();
                void products.refetch();
              }}
            />
          </DialogBody>
        ) : (
          <form
            className="contents"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogBody className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${ids}-depot`}>{t.depot}</Label>
                  <NativeSelect
                    id={`${ids}-depot`}
                    value={depotId}
                    onChange={(event) => setDepotId(event.target.value)}
                    aria-invalid={invalid && !depotId}
                    autoFocus
                  >
                    <option value="">{t.choose}</option>
                    {activeDepots.map((depot) => (
                      <option key={depot.id} value={depot.id}>
                        {depot.code} — {depot.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${ids}-product`}>{t.product}</Label>
                  <NativeSelect
                    id={`${ids}-product`}
                    value={productId}
                    onChange={(event) => setProductId(event.target.value)}
                    aria-invalid={invalid && !productId}
                  >
                    <option value="">{t.choose}</option>
                    {(products.data ?? []).map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.label}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${ids}-liters`}>{t.newStock}</Label>
                <div className="w-48">
                  <NumberInput
                    id={`${ids}-liters`}
                    value={liters}
                    onChange={setLiters}
                    unit={fr.fields.litersUnit}
                    grouped
                    aria-invalid={invalid && (liters === null || liters < 0)}
                    aria-describedby={`${ids}-liters-hint`}
                  />
                </div>
                <p id={`${ids}-liters-hint`} className="text-xs text-muted-foreground">
                  {t.newStockHint}
                </p>
              </div>
              <EventTimeField
                label={fr.screens.events.eventTime.shortage}
                value={time}
                onChange={setTime}
                invalid={!eventTime.valid}
              />
              {invalid && (!depotId || !productId || liters === null || liters < 0) && (
                <p role="alert" className="text-xs text-destructive">
                  {t.required}
                </p>
              )}
              <ApiErrorNotice title={t.failed} error={error} />
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {fr.common.cancel}
              </Button>
              <Button type="submit" disabled={shortage.isPending}>
                {shortage.isPending && <Spinner className="text-current" />}
                {shortage.isPending ? t.submitting : t.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
