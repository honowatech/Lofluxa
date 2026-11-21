/** Écran 1 — Connexion (e-mail + mot de passe ; comptes créés par l'administrateur). */
import { zodResolver } from "@hookform/resolvers/zod";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";

import { homePathFor } from "@/app/guards";
import { LOGIN_PATH } from "@/app/screens";
import { Notice } from "@/components/PageHeader";
import { LoadingState, Spinner } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fr } from "@/i18n/fr";
import { errorMessage } from "@/lib/api/errors";
import { useSession } from "@/lib/auth/session";

const schema = z.object({
  email: z.string().trim().min(1, fr.auth.emailInvalid).email(fr.auth.emailInvalid),
  password: z.string().min(1, fr.auth.passwordRequired),
});
type Values = z.infer<typeof schema>;

export default function LoginPage() {
  const { status, user, expired, login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as { from?: string; loggedOut?: boolean };
  const [showPassword, setShowPassword] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const target = (role: Parameters<typeof homePathFor>[0]) =>
    state.from && !state.from.startsWith(LOGIN_PATH) ? state.from : homePathFor(role);

  if (status === "authenticated" && user) return <Navigate to={target(user.role)} replace />;
  if (status === "loading") return <LoadingState label={fr.auth.checking} className="h-screen" />;

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      const me = await login(values.email, values.password);
      navigate(target(me.role), { replace: true });
    } catch (error) {
      setFailure(errorMessage(error));
      setFocus("password");
    }
  });

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex lg:flex-col">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
            <path
              d="M5 22c5-11 9 4 13-6s5-6 9-6"
              fill="none"
              stroke="hsl(var(--signal))"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <circle cx="5" cy="22" r="3" fill="#fff" />
            <circle cx="27" cy="10" r="3" fill="hsl(var(--signal))" />
          </svg>
          <span className="text-xl font-semibold tracking-tight text-white">{fr.app.name}</span>
        </div>
        {/* Motif : un réseau de tournées, du dépôt aux stations. */}
        <svg viewBox="0 0 400 300" className="my-auto w-full max-w-md opacity-90" aria-hidden>
          <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5">
            <path d="M60 220 L130 150 L210 170 L250 90 L60 220" stroke="hsl(var(--signal))" />
            <path d="M60 220 L150 250 L260 235 L330 170 L60 220" stroke="hsl(190 50% 55%)" />
            <path d="M60 220 L90 110 L170 60 L60 220" stroke="hsl(190 20% 45%)" strokeDasharray="5 6" />
          </g>
          <rect x="50" y="210" width="20" height="20" rx="4" fill="#fff" />
          {[
            [130, 150, 1],
            [210, 170, 2],
            [250, 90, 3],
            [150, 250, 1],
            [260, 235, 2],
            [330, 170, 3],
            [90, 110, 1],
            [170, 60, 2],
          ].map(([x, y, n], index) => (
            <g key={index} transform={`translate(${x} ${y})`}>
              <circle
                r="10"
                fill="hsl(var(--sidebar))"
                stroke={
                  index < 3 ? "hsl(var(--signal))" : index < 6 ? "hsl(190 50% 55%)" : "hsl(190 20% 45%)"
                }
                strokeWidth="2.5"
              />
              <text
                textAnchor="middle"
                dy="3.5"
                fontSize="10"
                fontFamily="IBM Plex Mono, monospace"
                fill="#fff"
              >
                {n}
              </text>
            </g>
          ))}
        </svg>
        <div>
          <p className="text-lg font-medium text-white">{fr.app.tagline}</p>
          <p className="text-sm text-sidebar-muted">{fr.app.client}</p>
        </div>
      </aside>

      <main className="flex items-center justify-center p-6">
        <form
          onSubmit={(event) => void onSubmit(event)}
          noValidate
          className="flex w-full max-w-sm flex-col gap-4"
        >
          <div>
            <p className="text-sm font-semibold text-primary lg:hidden">{fr.app.name}</p>
            <h1 className="text-xl font-semibold tracking-tight">{fr.auth.title}</h1>
            <p className="text-xs text-muted-foreground">{fr.auth.subtitle}</p>
          </div>

          {failure ? (
            <Notice tone="blocking">{failure}</Notice>
          ) : expired ? (
            <Notice tone="warning">{fr.auth.expired}</Notice>
          ) : state.loggedOut ? (
            <Notice tone="neutral">{fr.auth.loggedOut}</Notice>
          ) : null}

          <div className="flex flex-col gap-1">
            <Label htmlFor="email">{fr.auth.email}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              autoFocus
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "email-error" : undefined}
              className="h-9"
              {...register("email")}
            />
            {errors.email && (
              <p id="email-error" role="alert" className="text-xs text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="password">{fr.auth.password}</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                aria-invalid={!!errors.password}
                aria-describedby={errors.password ? "password-error" : undefined}
                className="h-9 pr-9"
                {...register("password")}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? fr.auth.hidePassword : fr.auth.showPassword}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:bg-muted focus-ring"
              >
                {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            {errors.password && (
              <p id="password-error" role="alert" className="text-xs text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>

          <Button type="submit" size="lg" disabled={isSubmitting}>
            {isSubmitting && <Spinner className="text-current" />}
            {isSubmitting ? fr.auth.submitting : fr.auth.submit}
          </Button>
          <p className="text-xs text-muted-foreground">{fr.auth.noAccount}</p>
        </form>
      </main>
    </div>
  );
}
