import { ChevronDown, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fr } from "@/i18n/fr";
import { useSession } from "@/lib/auth/session";

import { LOGIN_PATH } from "../screens";

export function UserMenu() {
  const user = useSession((state) => state.user);
  const logout = useSession((state) => state.logout);
  const navigate = useNavigate();
  if (!user) return null;

  const initials = user.full_name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-8 items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted focus-ring"
        aria-label={`${fr.shell.account} : ${user.full_name}`}
        data-testid="user-menu"
      >
        <span className="grid size-6 place-items-center rounded-full bg-primary text-2xs font-semibold text-primary-foreground">
          {initials}
        </span>
        <span className="hidden leading-tight sm:block">
          <span className="block max-w-40 truncate text-xs font-medium" data-testid="user-name">
            {user.full_name}
          </span>
          <span className="block text-2xs text-muted-foreground" data-testid="user-role">
            {fr.roles[user.role]}
          </span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>
          <span className="block text-sm font-medium text-foreground">{user.full_name}</span>
          <span className="num block">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void logout().then(() => navigate(LOGIN_PATH, { replace: true, state: { loggedOut: true } }));
          }}
        >
          <LogOut />
          {fr.shell.logout}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
