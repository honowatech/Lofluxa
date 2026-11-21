import { RotateCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { useConfirm } from "@/components/ConfirmDialog";
import { NumberInput, TimeInput } from "@/components/forms";
import { notify } from "@/components/notify";
import { Notice } from "@/components/PageHeader";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { isApiError } from "@/lib/api/errors";
import { useSettings, useUpdateSettings } from "@/lib/api/settings";
import { formatDateTime } from "@/lib/format";
import type { Setting, SettingValue } from "@/lib/types";
import { cn } from "@/lib/utils";

import { GROUP_ORDER, metaFor, validateSetting, type SettingMeta } from "./settingsCatalog";

const t = fr.administration.settings;

const show = (value: SettingValue | undefined, unit?: string): string =>
  value === null || value === undefined || value === ""
    ? t.empty
    : `${String(value).replace(".", typeof value === "number" ? "," : ".")}${unit ? ` ${unit}` : ""}`;

interface Row {
  setting: Setting;
  meta: SettingMeta;
  defaultValue: SettingValue;
  description: string;
}

export function SettingsTab() {
  const query = useSettings();
  const save = useUpdateSettings();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");

  const rows = useMemo<Row[]>(
    () =>
      (query.data ?? []).map((setting) => {
        const meta = metaFor(setting.key, setting.value);
        return {
          setting,
          meta,
          defaultValue: setting.default_value !== undefined ? setting.default_value : meta.fallbackDefault,
          description: setting.description || meta.fallbackDescription,
        };
      }),
    [query.data],
  );

  if (query.isLoading) return <LoadingState />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const valueOf = (row: Row): SettingValue =>
    row.setting.key in draft ? draft[row.setting.key] : row.setting.value;
  const changed = rows.filter(
    (row) => row.setting.key in draft && draft[row.setting.key] !== row.setting.value,
  );
  const errors = Object.fromEntries(
    changed
      .map((row) => [row.setting.key, validateSetting(row.meta, draft[row.setting.key])])
      .filter(([, message]) => message),
  ) as Record<string, string>;
  const hasErrors = Object.keys(errors).length > 0;

  const setValue = (key: string, value: SettingValue) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setServerErrors((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
  };

  const needle = filter.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      !needle ||
      row.setting.key.toLowerCase().includes(needle) ||
      row.description.toLowerCase().includes(needle),
  );

  const submit = async () => {
    const ok = await confirm({
      title: t.confirmTitle,
      confirmLabel: fr.common.save,
      description: (
        <div className="flex flex-col gap-2">
          <p>{t.confirmBody}</p>
          <ul className="flex flex-col gap-1 text-foreground">
            {changed.map((row) => (
              <li key={row.setting.key} className="text-xs">
                <span className="num font-medium">{row.setting.key}</span> :{" "}
                <span className="num text-muted-foreground line-through">
                  {show(row.setting.value, row.meta.unit)}
                </span>
                {" → "}
                <span className="num font-medium">{show(draft[row.setting.key], row.meta.unit)}</span>
              </li>
            ))}
          </ul>
        </div>
      ),
    });
    if (!ok) return;
    try {
      await save.mutateAsync(
        Object.fromEntries(changed.map((row) => [row.setting.key, draft[row.setting.key]])),
      );
      notify.success(t.saved(changed.length));
      setDraft({});
      setServerErrors({});
    } catch (error) {
      if (isApiError(error)) setServerErrors(error.fieldErrors);
      notify.apiError(error, fr.errors.saveFailed);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t.search}
            aria-label={t.search}
            className="h-7 w-64 pl-7 text-xs"
          />
        </div>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t.intro}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card">
        <table
          className="w-full border-separate border-spacing-0 text-sm"
          aria-label={fr.administration.tabs.settings}
        >
          <thead className="sticky top-0 z-10">
            <tr className="text-left text-xs text-foreground/70">
              <th scope="col" className="h-8 border-b bg-muted px-3 font-semibold">
                {t.description}
              </th>
              <th scope="col" className="h-8 w-56 border-b bg-muted px-3 font-semibold">
                {t.value}
              </th>
              <th scope="col" className="h-8 w-40 border-b bg-muted px-3 font-semibold">
                {t.defaultValue}
              </th>
              <th scope="col" className="h-8 w-44 border-b bg-muted px-3 font-semibold">
                {t.modified}
              </th>
            </tr>
          </thead>
          {GROUP_ORDER.map((group) => {
            const groupRows = visible.filter((row) => row.meta.group === group);
            if (groupRows.length === 0) return null;
            return (
              <tbody key={group}>
                <tr>
                  <th
                    colSpan={4}
                    scope="rowgroup"
                    className="border-b bg-background px-3 py-1 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-foreground/60"
                  >
                    {t.groups[group]}
                  </th>
                </tr>
                {groupRows.map((row) => {
                  const { key } = row.setting;
                  const value = valueOf(row);
                  const dirty = changed.includes(row);
                  const error = errors[key] ?? serverErrors[key];
                  const isDefault =
                    value === row.defaultValue ||
                    ((value === null || value === "") && row.defaultValue === null);
                  const common = {
                    id: `setting-${key}`,
                    "aria-invalid": !!error,
                    "aria-describedby": error ? `setting-${key}-error` : undefined,
                    className: "h-7",
                  };
                  return (
                    <tr key={key} data-setting={key} className={cn(dirty && "bg-signal/10")}>
                      <td className="border-b px-3 py-1.5 align-top">
                        <label htmlFor={`setting-${key}`} className="block text-sm">
                          {row.description}
                        </label>
                        <span className="num text-xs text-muted-foreground">{key}</span>
                      </td>
                      <td className="border-b px-3 py-1.5 align-top">
                        {row.meta.type === "number" || row.meta.type === "integer" ? (
                          <NumberInput
                            {...common}
                            unit={row.meta.unit}
                            value={value as number | null}
                            onChange={(next) => setValue(key, next)}
                          />
                        ) : row.meta.type === "time" ? (
                          <TimeInput
                            {...common}
                            value={(value as string | null) ?? ""}
                            onChange={(next) => setValue(key, next)}
                          />
                        ) : (
                          <Input
                            {...common}
                            value={(value as string | null) ?? ""}
                            onChange={(event) =>
                              setValue(
                                key,
                                event.target.value === "" && row.meta.nullable ? null : event.target.value,
                              )
                            }
                          />
                        )}
                        {error && (
                          <p
                            id={`setting-${key}-error`}
                            role="alert"
                            className="mt-0.5 text-xs text-destructive"
                          >
                            {error}
                          </p>
                        )}
                      </td>
                      <td className="border-b px-3 py-1.5 align-top">
                        <span className="flex items-center gap-1">
                          <span className="num text-xs text-muted-foreground">
                            {show(row.defaultValue, row.meta.unit)}
                          </span>
                          {!isDefault && (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              title={t.restoreDefault}
                              aria-label={`${t.restoreDefault} — ${key}`}
                              onClick={() => setValue(key, row.defaultValue)}
                            >
                              <RotateCcw />
                            </Button>
                          )}
                        </span>
                      </td>
                      <td className="border-b px-3 py-1.5 align-top text-xs text-muted-foreground">
                        {dirty ? (
                          <Badge tone="warning">{t.modified}</Badge>
                        ) : row.setting.updated_at ? (
                          <span className="num">{formatDateTime(row.setting.updated_at)}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>

      <div className="flex items-center gap-2">
        {hasErrors && (
          <Notice tone="blocking" className="flex-1">
            {fr.table.invalidValue}
          </Notice>
        )}
        <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
          {changed.length === 0 ? t.noChanges : null}
        </span>
        <Button
          variant="outline"
          disabled={Object.keys(draft).length === 0 || save.isPending}
          onClick={() => {
            setDraft({});
            setServerErrors({});
          }}
        >
          {t.discard}
        </Button>
        <Button disabled={changed.length === 0 || hasErrors || save.isPending} onClick={() => void submit()}>
          {changed.length === 0 ? fr.common.save : t.save(changed.length)}
        </Button>
      </div>
    </div>
  );
}
