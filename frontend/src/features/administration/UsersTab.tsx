import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, Pencil, Plus, UserCheck, UserX, Wand2 } from "lucide-react";
import { useState, useMemo } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { z } from "zod";

import { useConfirm } from "@/components/ConfirmDialog";
import { DataTable, RowActions, useDataTableState } from "@/components/DataTable";
import { EntityFormDialog, SelectField, SwitchField, TextField, zText } from "@/components/forms";
import { notify } from "@/components/notify";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fr } from "@/i18n/fr";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { ApiError } from "@/lib/api/errors";
import { PASSWORD_MIN_LENGTH } from "@/lib/config";
import { useCurrentUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { ROLES, type Role, type User } from "@/lib/types";

import { users } from "./resources";

const t = fr.administration.users;

const NONE: never[] = [];
const roleOptions = ROLES.map((value) => ({ value, label: fr.roles[value] }));
const zPassword = z.string().min(PASSWORD_MIN_LENGTH, t.passwordTooShort(PASSWORD_MIN_LENGTH)).max(128);

const createSchema = z.object({
  email: z.string().trim().toLowerCase().min(1, fr.common.required).email(fr.fields.emailInvalid),
  full_name: zText(160),
  role: z.enum(ROLES),
  password: zPassword,
});
const editSchema = z.object({ full_name: zText(160), role: z.enum(ROLES), active: z.boolean() });
const resetSchema = z.object({ password: zPassword });

/** Mot de passe aléatoire de 16 caractères, sans caractères ambigus. */
export function generatePassword(length = 16): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function PasswordField({ label }: { label: string }) {
  const { setValue } = useFormContext<{ password: string }>();
  return (
    <div className="flex items-end gap-2">
      <TextField<{ password: string }>
        name="password"
        label={label}
        required
        mono
        autoComplete="off"
        hint={t.passwordHint(PASSWORD_MIN_LENGTH)}
        className="flex-1"
      />
      <Button
        variant="outline"
        className="mb-[1.375rem]"
        onClick={() => setValue("password", generatePassword(), { shouldDirty: true, shouldValidate: true })}
      >
        <Wand2 />
        {t.generate}
      </Button>
    </div>
  );
}

function RoleHelp() {
  const role = useWatch({ name: "role" }) as Role | undefined;
  return role ? <p className="-mt-3 text-xs text-muted-foreground">{t.roleHelp[role]}</p> : null;
}

type DialogState = { mode: "create" } | { mode: "edit" | "reset"; user: User } | null;

export function UsersTab() {
  const me = useCurrentUser();
  const confirm = useConfirm();
  const [state, setState] = useDataTableState({ sorting: [{ id: "full_name", desc: false }] });
  const list = users.useAll({}, { staleTime: 0 });
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: users.keys.all });
  // Activation, désactivation et réinitialisation ont leurs propres routes (la désactivation ferme les sessions du compte).
  const toggle = useMutation<User, ApiError, { id: string; active: boolean }>({
    mutationFn: ({ id, active }) =>
      api<User>(`/users/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" }),
    onSuccess: refresh,
  });
  const resetPassword = useMutation<void, ApiError, { id: string; password: string }>({
    mutationFn: ({ id, password }) =>
      api(`/users/${id}/reset-password`, { method: "POST", body: { password } }),
  });
  const create = users.useCreate();
  const update = users.useUpdate();
  const [dialog, setDialog] = useState<DialogState>(null);

  const setActive = async (user: User, active: boolean) => {
    if (
      !active &&
      !(await confirm({
        title: t.deactivateTitle,
        description: t.deactivateBody(user.full_name),
        confirmLabel: t.deactivate,
        destructive: true,
      }))
    )
      return;
    try {
      await toggle.mutateAsync({ id: user.id, active });
      notify.success(active ? t.activated(user.full_name) : t.deactivated(user.full_name));
    } catch (error) {
      notify.apiError(error, fr.errors.saveFailed);
    }
  };

  // Colonnes mémorisées : une nouvelle définition à chaque rendu remonterait toutes les cellules (menus, édition).
  const columns = useMemo<ColumnDef<User, unknown>[]>(
    () => [
      {
        accessorKey: "full_name",
        header: t.fullName,
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            {row.original.full_name}
            {row.original.id === me?.id && <Badge tone="primary">{t.self}</Badge>}
          </span>
        ),
      },
      {
        accessorKey: "email",
        header: t.email,
        cell: ({ row }) => <span className="num">{row.original.email}</span>,
      },
      {
        accessorKey: "role",
        header: t.role,
        meta: { className: "w-36" },
        cell: ({ row }) => (
          <Badge tone={row.original.role === "admin" ? "primary" : "neutral"}>
            {fr.roles[row.original.role]}
          </Badge>
        ),
      },
      {
        accessorKey: "active",
        header: t.status,
        meta: { className: "w-24" },
        cell: ({ row }) => <StatusBadge kind="active" value={row.original.active} />,
      },
      {
        accessorKey: "last_login_at",
        header: t.lastLogin,
        meta: { className: "w-40" },
        cell: ({ row }) =>
          row.original.last_login_at ? (
            <span className="num">{formatDateTime(row.original.last_login_at)}</span>
          ) : (
            <span className="text-muted-foreground">{t.never}</span>
          ),
      },
      {
        id: "__actions",
        enableSorting: false,
        header: () => <span className="sr-only">{fr.common.actions}</span>,
        meta: { className: "w-9", align: "right", label: fr.common.actions },
        cell: ({ row }) => {
          const user = row.original;
          const isSelf = user.id === me?.id;
          return (
            <RowActions
              label={`${fr.common.actions} — ${user.full_name}`}
              items={[
                {
                  label: fr.common.edit,
                  icon: <Pencil />,
                  onSelect: () => setDialog({ mode: "edit", user }),
                },
                {
                  label: t.resetPassword,
                  disabled: isSelf,
                  icon: <KeyRound />,
                  onSelect: () => setDialog({ mode: "reset", user }),
                },
                "separator",
                user.active
                  ? {
                      label: t.deactivate,
                      icon: <UserX />,
                      destructive: true,
                      disabled: isSelf,
                      onSelect: () => void setActive(user, false),
                    }
                  : { label: t.activate, icon: <UserCheck />, onSelect: () => void setActive(user, true) },
              ]}
            />
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me?.id],
  );

  const editing = dialog?.mode === "edit" ? dialog.user : null;
  const resetting = dialog?.mode === "reset" ? dialog.user : null;
  const editingSelf = editing?.id === me?.id;

  return (
    <>
      <DataTable<User>
        caption={fr.administration.tabs.users}
        columns={columns}
        data={list.data ?? NONE}
        state={state}
        onStateChange={setState}
        loading={list.isLoading}
        fetching={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        getRowId={(row) => row.id}
        searchable
        filters={[
          { id: "role", label: t.role, options: roleOptions },
          {
            id: "active",
            label: t.status,
            options: [
              { value: "true", label: fr.common.active },
              { value: "false", label: fr.common.inactive },
            ],
          },
        ]}
        onRowActivate={(user) => setDialog({ mode: "edit", user })}
        empty={t.empty}
        className="h-full"
        toolbar={
          <Button size="sm" onClick={() => setDialog({ mode: "create" })}>
            <Plus />
            {t.new}
          </Button>
        }
      />

      <EntityFormDialog
        open={dialog?.mode === "create"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t.new}
        placement="center"
        schema={createSchema}
        defaultValues={{ email: "", full_name: "", role: "dispatcher", password: "" }}
        submitLabel={fr.common.create}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
          notify.success(t.created(values.full_name));
        }}
      >
        <TextField name="full_name" label={t.fullName} required autoFocus />
        <TextField name="email" label={t.email} required type="email" autoComplete="off" />
        <SelectField name="role" label={t.role} options={roleOptions} required />
        <RoleHelp />
        <PasswordField label={t.password} />
      </EntityFormDialog>

      <EntityFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t.edit}
        description={editing?.email}
        placement="center"
        schema={editSchema}
        defaultValues={{
          full_name: editing?.full_name ?? "",
          role: editing?.role ?? "dispatcher",
          active: editing?.active ?? true,
        }}
        onSubmit={async (values) => {
          if (!editing) return;
          // Son propre compte : ni rôle ni état (refusés par le serveur), seulement le nom.
          await update.mutateAsync({
            id: editing.id,
            input: editingSelf ? { full_name: values.full_name } : values,
          });
          notify.success(t.updated(values.full_name));
        }}
      >
        <TextField name="full_name" label={t.fullName} required autoFocus />
        <SelectField name="role" label={t.role} options={roleOptions} required disabled={editingSelf} />
        <RoleHelp />
        <SwitchField name="active" label={t.active} disabled={editingSelf} />
        {editingSelf && <p className="text-xs text-muted-foreground">{t.selfLock}</p>}
      </EntityFormDialog>

      <EntityFormDialog
        open={resetting !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title={resetting ? t.resetPasswordFor(resetting.full_name) : t.resetPassword}
        description={resetting?.email}
        placement="center"
        schema={resetSchema}
        defaultValues={{ password: "" }}
        submitLabel={t.resetPassword}
        onSubmit={async (values) => {
          if (!resetting) return;
          await resetPassword.mutateAsync({ id: resetting.id, password: values.password });
          notify.success(t.resetDone(resetting.full_name));
        }}
      >
        <PasswordField label={t.newPassword} />
      </EntityFormDialog>
    </>
  );
}
