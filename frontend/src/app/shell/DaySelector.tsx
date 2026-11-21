/** Sélecteur du jour J : partagé par tous les écrans, conservé dans l'URL (`?day=`). */
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fr } from "@/i18n/fr";
import { formatDateLong, isValidDay } from "@/lib/format";
import { useDay } from "@/lib/useDay";
import { cn } from "@/lib/utils";

export function DaySelector() {
  const { day, setDay, isToday, previous, next, goToday } = useDay();
  return (
    <div className="flex items-center gap-1" role="group" aria-label={fr.shell.day}>
      <span className="mr-1 text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {fr.shell.day}
      </span>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={previous}
        aria-label={fr.shell.previousDay}
        title={fr.shell.previousDay}
      >
        <ChevronLeft />
      </Button>
      <Input
        type="date"
        aria-label={fr.shell.day}
        value={day}
        onChange={(event) => isValidDay(event.target.value) && setDay(event.target.value)}
        className="num h-7 w-[8.25rem] px-1.5"
      />
      <Button
        variant="outline"
        size="icon-sm"
        onClick={next}
        aria-label={fr.shell.nextDay}
        title={fr.shell.nextDay}
      >
        <ChevronRight />
      </Button>
      <span
        className="ml-1.5 hidden w-36 truncate text-sm font-medium first-letter:uppercase md:inline-block"
        data-testid="day-label"
      >
        {formatDateLong(day)}
      </span>
      <Button
        variant={isToday ? "ghost" : "secondary"}
        size="sm"
        onClick={goToday}
        disabled={isToday}
        title={fr.shell.goToday}
        className={cn(isToday && "text-muted-foreground")}
      >
        {fr.common.today}
      </Button>
    </div>
  );
}
