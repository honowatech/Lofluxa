/** Vue schématique en SVG : mêmes données que la carte, sans fond ni WebGL. Positions à l'échelle. */
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { fr } from "@/i18n/fr";
import { cn } from "@/lib/utils";

import { fitProjection, isValidPosition } from "./geometry";
import type { MapRendererProps } from "./types";

interface Hover {
  x: number;
  y: number;
  title: string;
  kind: string;
  detail: string[];
}

export function SchematicMap({
  points,
  routes,
  selectedId,
  onSelect,
  onMapClick,
  onRouteClick,
  onRouteHover,
  fitBounds,
}: MapRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [hover, setHover] = useState<Hover | null>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const projection = useMemo(() => fitProjection(fitBounds, size.width, size.height), [fitBounds, size]);

  const handleBackgroundClick = (event: MouseEvent<SVGSVGElement>) => {
    if (!onMapClick) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onMapClick(projection.unproject(event.clientX - rect.left, event.clientY - rect.top));
  };

  const interactive = (id: string, kind: "depot" | "station" | "stop", label: string) =>
    onSelect
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-label": label,
          onClick: (event: MouseEvent) => {
            event.stopPropagation();
            onSelect(id, kind);
          },
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(id, kind);
            }
          },
        }
      : { role: "img" as const, "aria-label": label };

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden bg-[hsl(90_10%_94%)]">
      <svg
        data-testid="schematic-map"
        width="100%"
        height="100%"
        viewBox={`0 0 ${size.width} ${size.height}`}
        onClick={handleBackgroundClick}
        className={cn(onMapClick && "cursor-crosshair")}
      >
        <defs>
          <pattern id="tn-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="hsl(90 7% 85%)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#tn-grid)" />

        {routes.map((route) => {
          const path = route.path.filter(isValidPosition).map((p) => projection.project(p));
          if (path.length < 2) return null;
          const d = path.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
          return (
            <g key={route.id} data-route={route.id} opacity={route.dimmed ? 0.35 : 1}>
              <path
                d={d}
                fill="none"
                stroke="#fff"
                strokeWidth={6}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <path
                d={d}
                fill="none"
                stroke={route.color}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {(onRouteClick || onRouteHover) && (
                <path
                  d={d}
                  data-route-hit={route.id}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={16}
                  role={onRouteClick ? "button" : undefined}
                  tabIndex={onRouteClick ? 0 : undefined}
                  aria-label={route.label}
                  className={cn("outline-none", onRouteClick && "cursor-pointer")}
                  onClick={(event) => {
                    if (!onRouteClick) return;
                    event.stopPropagation();
                    onRouteClick(route.id);
                  }}
                  onKeyDown={(event) => {
                    if (onRouteClick && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onRouteClick(route.id);
                    }
                  }}
                  onMouseEnter={() => onRouteHover?.(route.id)}
                  onMouseLeave={() => onRouteHover?.(null)}
                />
              )}
            </g>
          );
        })}

        {points.filter(isValidPosition).map((point) => {
          const { x, y } = projection.project(point);
          const selected = selectedId === point.id;
          const kindLabel =
            point.variant === "unserved"
              ? fr.map.unserved
              : point.kind === "depot"
                ? fr.map.depot
                : fr.map.station;
          return (
            <g
              key={point.id}
              data-point={point.id}
              data-kind={point.kind}
              data-variant={point.variant}
              data-selected={selected || undefined}
              transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
              opacity={point.inactive ? 0.45 : 1}
              className={cn("outline-none", onSelect && "cursor-pointer")}
              onMouseEnter={() =>
                setHover({ x, y, title: point.label, kind: kindLabel, detail: point.detail ?? [] })
              }
              onMouseLeave={() => setHover(null)}
              onFocus={() =>
                setHover({ x, y, title: point.label, kind: kindLabel, detail: point.detail ?? [] })
              }
              onBlur={() => setHover(null)}
              {...interactive(point.id, point.kind, `${kindLabel} ${point.label}`)}
            >
              {selected && <circle r={13} fill="none" stroke="hsl(var(--signal))" strokeWidth={3} />}
              {point.variant === "unserved" ? (
                <rect
                  x={-6}
                  y={-6}
                  width={12}
                  height={12}
                  transform="rotate(45)"
                  fill="#fff"
                  stroke="hsl(var(--foreground))"
                  strokeWidth={2}
                  strokeDasharray="3 2"
                />
              ) : point.kind === "depot" ? (
                <rect
                  x={-8}
                  y={-8}
                  width={16}
                  height={16}
                  rx={3}
                  fill="hsl(var(--sidebar))"
                  stroke="#fff"
                  strokeWidth={2}
                />
              ) : (
                <circle r={6} fill="hsl(var(--primary))" stroke="#fff" strokeWidth={2} />
              )}
            </g>
          );
        })}

        {routes.flatMap((route) =>
          (route.stops ?? []).filter(isValidPosition).map((stop) => {
            const { x, y } = projection.project(stop);
            const selected = selectedId === stop.id;
            return (
              <g
                key={`${route.id}-${stop.id}`}
                data-stop={stop.id}
                transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}
                opacity={route.dimmed ? 0.45 : 1}
                className={cn("outline-none", onSelect && "cursor-pointer")}
                onMouseEnter={() =>
                  setHover({
                    x,
                    y,
                    title: stop.label,
                    kind: fr.map.stop(stop.seq),
                    detail: stop.detail ?? [],
                  })
                }
                onMouseLeave={() => setHover(null)}
                {...interactive(stop.id, "stop", `${fr.map.stop(stop.seq)} ${stop.label}`)}
              >
                {selected && <circle r={14} fill="none" stroke="hsl(var(--signal))" strokeWidth={3} />}
                <circle r={10} fill={route.color} stroke="#fff" strokeWidth={2} />
                <text
                  textAnchor="middle"
                  dy="3.5"
                  fontSize="10"
                  fontFamily="IBM Plex Mono, monospace"
                  fontWeight="500"
                  fill="#fff"
                >
                  {stop.seq}
                </text>
              </g>
            );
          }),
        )}
      </svg>

      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 -translate-y-full rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-pop"
          style={{ left: hover.x, top: hover.y - 14 }}
        >
          <p className="text-2xs uppercase tracking-wide text-muted-foreground">{hover.kind}</p>
          <p className="font-semibold">{hover.title}</p>
          {hover.detail.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
