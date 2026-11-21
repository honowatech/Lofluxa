/** Déclaration d'une pénurie produit au dépôt (F6.3) et tournées impactées. */
import { ArrowRight, CheckCircle2, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";

import { NumberInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
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
import { ViolationsPanel } from "@/components/ViolationsPanel";
import { fr } from "@/i18n/fr";
import { errorMessage, isApiError } from "@/lib/api";
import { formatLiters } from "@/lib/format";
import type { IsoDate } from "@/lib/types";
import { withDay } from "@/lib/useDay";

import { useDepots, useProductShortage, useProducts, type ShortageResult } from "./api";
import { planLink } from "./summary";

const t = fr.screens.events.shortage;

interface Declared {
  result: ShortageResult;
  depot: string;
  product: string;
  liters: number;
}

export function ShortageDialog({
  day,
  open,
  onOpenChange,
}: {
  day: IsoDate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ids = useId();
  const depots = useDepots(open);
  const products = useProducts(open);
  const shortage = useProductShortage();
  const [depotId, setDepotId] = useState("");
  const [productId, setProductId] = useState("");
  const [liters, setLiters] = useState<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [declared, setDeclared] = useState<Declared | null>(null);

  const reset = () => {
    setDepotId("");
    setProductId("");
    setLiters(null);
    setInvalid(false);
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
    if (!depotId || !productId || liters === null || liters < 0) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    try {
      const result = await shortage.mutateAsync({
        depot_id: depotId,
        product_id: productId,
        new_available_l: liters,
      });
      const depot = activeDepots.find((item) => item.id === depotId);
      const product = products.data?.find((item) => item.id === productId);
      setDeclared({ result, depot: depot?.code ?? "", product: product?.label ?? "", liters });
      notify.success(t.done.toast);
    } catch {
      // L'erreur est affichée dans la boîte (state de la mutation).
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
              <Notice tone="info" icon={<CheckCircle2 className="size-4" aria-hidden />}>
                <strong className="font-semibold">{t.done.title}.</strong>{" "}
                {t.done.stock(
                  declared.product,
                  declared.depot,
                  formatLiters(declared.result.available_l ?? declared.liters),
                )}
              </Notice>
              {declared.result.impacted_trips.length === 0 ? (
                <p className="text-sm">{t.done.none}</p>
              ) : (
                <section aria-label={t.done.impactedTitle(declared.result.impacted_trips.length)}>
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold text-warning">
                    <TriangleAlert className="size-4" aria-hidden />
                    {t.done.impactedTitle(declared.result.impacted_trips.length)}
                  </h3>
                  <p className="mb-2 mt-0.5 text-xs text-muted-foreground">{t.done.choicesHint}</p>
                  <ul className="divide-y rounded-md border">
                    {declared.result.impacted_trips.map((trip) => {
                      const plan = trip.plan_id
                        ? `${planLink(trip.plan_id, day)}&trip=${trip.trip_id}`
                        : withDay("/plan", day);
                      return (
                        <li
                          key={trip.trip_id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                          data-testid="impacted-trip"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">
                              {fr.screens.events.feed.trip(trip.trip_seq, trip.truck_plate)}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {[
                                trip.driver_name,
                                trip.planned_l !== null
                                  ? `${t.done.planned} ${formatLiters(trip.planned_l)}`
                                  : null,
                                trip.shortfall_l !== null
                                  ? `${t.done.shortfall} ${formatLiters(trip.shortfall_l)}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </p>
                          </div>
                          <div className="flex gap-1.5">
                            <Button asChild variant="outline" size="sm">
                              <Link to={plan}>{t.done.reduce}</Link>
                            </Button>
                            <Button asChild variant="outline" size="sm">
                              <Link to={withDay("/commandes", day)}>{t.done.postpone}</Link>
                            </Button>
                            <Button asChild variant="outline" size="sm">
                              <Link to={plan}>{t.done.changeDepot}</Link>
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={reset}>
                {t.done.another}
              </Button>
              <Button onClick={() => onOpenChange(false)}>{fr.common.close}</Button>
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
              {invalid && (
                <p role="alert" className="text-xs text-destructive">
                  {t.required}
                </p>
              )}
              {error && (
                <Notice tone="blocking">
                  <strong className="font-semibold">{t.failed}.</strong> {errorMessage(error)}
                </Notice>
              )}
              {isApiError(error) && <ViolationsPanel violations={error.violations} hideWhenEmpty />}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {fr.common.cancel}
              </Button>
              <Button type="submit" disabled={shortage.isPending}>
                {shortage.isPending && <Spinner className="text-current" />}
                {shortage.isPending ? t.submitting : t.submit}
                {!shortage.isPending && <ArrowRight aria-hidden />}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
