/** Envoi de la fiche de chargement par e-mail (F7.3) : destinataires proposés = gérants des stations de la tournée. */
import { Mail, Send } from "lucide-react";
import { useMemo, useState } from "react";

import { Notice } from "@/components/PageHeader";
import { notify } from "@/components/notify";
import { Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { isApiError } from "@/lib/api";

import { useEmailSheet, type EmailResult, type PlanTrip, type Station, type TripLoading } from "./api";

const t = fr.screens.loading.email;
const errors = fr.screens.loading.errors;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailDialog({
  trip,
  planTrip,
  stations,
  open,
  onOpenChange,
}: {
  trip: TripLoading;
  planTrip: PlanTrip | undefined;
  stations: Station[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const send = useEmailSheet(trip.id);
  // Une ligne par station de la tournée (dédoublonnée), avec l'adresse du gérant si elle est connue.
  const proposals = useMemo(() => {
    const seen = new Set<string>();
    return (planTrip?.stops ?? [])
      .filter((stop) => !seen.has(stop.station_id) && seen.add(stop.station_id))
      .map((stop) => ({
        id: stop.station_id,
        code: stop.station_code ?? "",
        name: stop.station_name ?? "",
        email:
          stations
            .find((station) => station.id === stop.station_id)
            ?.contact_email?.trim()
            .toLowerCase() || null,
      }));
  }, [planTrip, stations]);
  const withEmail = proposals.filter((proposal) => proposal.email);
  const withoutEmail = proposals.filter((proposal) => !proposal.email);

  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState("");
  const [result, setResult] = useState<EmailResult | null>(null);
  const [touched, setTouched] = useState(false);

  const extras = extra
    .split(/[\s,;]+/)
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  const invalid = extras.find((address) => !EMAIL.test(address));
  const recipients = [
    ...new Set([...withEmail.filter((p) => !unchecked.has(p.id)).map((p) => p.email as string), ...extras]),
  ];
  const problem = invalid ? t.invalid(invalid) : recipients.length === 0 ? t.none : null;
  const apiError = send.error && isApiError(send.error) ? send.error : null;

  const close = (next: boolean) => {
    if (!next) {
      setResult(null);
      setTouched(false);
      send.reset();
    }
    onOpenChange(next);
  };

  const submit = () => {
    setTouched(true);
    if (problem) return;
    send.mutate(recipients, {
      onSuccess: (sent) => {
        setResult(sent);
        notify.success(t.sent(sent.sent_to.length));
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description(trip.truck_plate ?? "")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          {result ? (
            <>
              <Notice tone="info" icon={<Mail className="size-4" aria-hidden />}>
                <span className="font-semibold">{t.sentTo}</span> : {result.sent_to.join(", ")}
              </Notice>
              {(result.stations_without_email.length > 0 || withoutEmail.length > 0) && (
                <Notice tone="warning">
                  {t.withoutEmail(
                    (result.stations_without_email.length > 0
                      ? result.stations_without_email
                      : withoutEmail.map((p) => p.code)
                    ).join(", "),
                  )}
                </Notice>
              )}
            </>
          ) : (
            <>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-xs font-medium text-foreground/80">{t.recipients}</legend>
                {proposals.map((proposal) => (
                  <label
                    key={proposal.id}
                    className="flex min-h-9 items-center gap-2 rounded-md border px-2 py-1 text-sm"
                  >
                    <Checkbox
                      checked={!!proposal.email && !unchecked.has(proposal.id)}
                      disabled={!proposal.email}
                      onCheckedChange={(checked) =>
                        setUnchecked((current) => {
                          const next = new Set(current);
                          if (checked) next.delete(proposal.id);
                          else next.add(proposal.id);
                          return next;
                        })
                      }
                    />
                    <span className="num text-xs text-muted-foreground">{proposal.code}</span>
                    <span className="truncate">{proposal.name}</span>
                    <span className={proposal.email ? "num ml-auto text-xs" : "ml-auto text-xs text-warning"}>
                      {proposal.email ?? t.noEmail}
                    </span>
                  </label>
                ))}
              </fieldset>
              {withoutEmail.length > 0 && (
                <Notice tone="warning">{t.withoutEmail(withoutEmail.map((p) => p.code).join(", "))}</Notice>
              )}
              <div className="flex flex-col gap-1">
                <label htmlFor="email-extra" className="text-xs font-medium text-foreground/80">
                  {t.extra}
                </label>
                <Input
                  id="email-extra"
                  value={extra}
                  onChange={(event) => setExtra(event.target.value)}
                  placeholder={t.extraPlaceholder}
                  aria-invalid={touched && !!invalid}
                  autoComplete="off"
                />
                <span className="text-xs text-muted-foreground">{t.extraHint}</span>
              </div>
              {touched && problem && <Notice tone="blocking">{problem}</Notice>}
              {apiError && (
                <Notice tone="blocking">
                  <p className="font-semibold">{t.failed}</p>
                  <p>{errors[apiError.code] ?? apiError.message}</p>
                </Notice>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {result ? fr.common.close : fr.common.cancel}
          </Button>
          {!result && (
            <Button onClick={submit} disabled={send.isPending}>
              {send.isPending ? <Spinner className="text-current" /> : <Send aria-hidden />}
              {send.isPending ? t.sending : t.send}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
