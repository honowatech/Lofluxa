"""Édition manuelle d'un plan (F5.1, F5.2) — lot L5.

Chaque opération : ouvre le plan en modification (nouvelle version si le plan est publié, RM-18),
applique le changement, recontrôle tout le plan (`checking.recheck`), journalise un événement
`manual_edit` (qui, quoi, quand) et renvoie le plan à jour. Aucune opération n'est refusée pour
cause de violation : les violations sont enregistrées et affichées, seule la publication est bloquée.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import EventType, PlanKind, PlanStatus, StopStatus, TripStatus
from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.planning.checking import load_plan, log_event, recheck
from app.planning.models import Plan, Stop, Trip
from app.planning.versions import IdMap, create_version
from app.referentials.models import Driver, Station, Truck


async def open_for_edit(session: AsyncSession, plan_id: uuid.UUID, *, reason: str) -> tuple[Plan, IdMap]:
    """Renvoie le plan modifiable et la correspondance des identifiants.

    - brouillon : le plan lui-même ;
    - publié : une nouvelle version brouillon (RM-18) — les identifiants de tournées et d'arrêts
      reçus du client désignent la version publiée et doivent passer par `IdMap` ;
    - archivé : refus."""
    plan = await load_plan(session, plan_id, for_update=True)
    ensure_not_reference(plan)
    if plan.status == PlanStatus.DRAFT:
        return plan, IdMap()
    if plan.status == PlanStatus.PUBLISHED:
        return await create_version(session, plan, reason=reason)
    raise ConflictError(
        "Ce plan est archivé : il ne peut plus être modifié. Restaurez cette version pour repartir d'elle.",
        code="plan_archived",
    )


def ensure_not_reference(plan: Plan) -> None:
    """Une journée de référence (`manual_reference`) est le relevé de ce qui a réellement été fait :
    elle ne se modifie pas, ne se recalcule pas et ne se restaure pas."""
    if plan.kind == PlanKind.MANUAL_REFERENCE:
        raise ConflictError(
            "Ce plan est une journée de référence importée : il ne peut être ni modifié ni recalculé.",
            code="plan_is_reference",
        )


def find_trip(plan: Plan, trip_id: uuid.UUID) -> Trip:
    trip = next((t for t in plan.trips if t.id == trip_id), None)
    if trip is None:
        raise NotFoundError("Tournée introuvable dans ce plan.")
    return trip


def _ensure_open(trip: Trip) -> None:
    if trip.status == TripStatus.COMPLETED:
        raise ConflictError(f"La tournée {trip.seq} est terminée : elle ne peut plus être modifiée.")


async def _finish(
    session: AsyncSession, plan: Plan, payload: dict[str, Any], trip_id: uuid.UUID | None
) -> Plan:
    await session.flush()
    plan = await load_plan(session, plan.id)
    await recheck(session, plan)
    log_event(session, plan, EventType.MANUAL_EDIT, payload, trip_id=trip_id)
    await session.flush()
    return await load_plan(session, plan.id)


async def move_stop(
    session: AsyncSession,
    plan_id: uuid.UUID,
    trip_id: uuid.UUID,
    stop_id: uuid.UUID,
    to_trip_id: uuid.UUID,
    to_seq: int,
) -> Plan:
    """Déplace un arrêt vers la position `to_seq` (à partir de 1) de la tournée `to_trip_id`.

    Une tournée qui n'a plus aucun arrêt est supprimée du plan."""
    plan, ids = await open_for_edit(session, plan_id, reason="Déplacement d'un arrêt")
    source = find_trip(plan, ids.trip(trip_id))
    target = find_trip(plan, ids.trip(to_trip_id))
    stop = next((s for s in source.stops if s.id == ids.stop(stop_id)), None)
    if stop is None:
        raise NotFoundError("Arrêt introuvable dans cette tournée.")
    if stop.status != StopStatus.PENDING:
        raise ConflictError("Cet arrêt est déjà livré ou sauté : il ne peut plus être déplacé.")
    _ensure_open(source)
    _ensure_open(target)
    max_seq = len(target.stops) + (0 if target is source else 1)
    if not 1 <= to_seq <= max_seq:
        raise ValidationAppError(
            f"Position invalide : la tournée {target.seq} accepte une position de 1 à {max_seq}.",
            details=[{"field": "to_seq", "message": f"Valeur attendue entre 1 et {max_seq}."}],
        )
    from_seq = stop.seq
    station = await session.get(Station, stop.station_id)

    source.stops.remove(stop)
    target.stops.insert(to_seq - 1, stop)
    _renumber(source)
    _renumber(target)
    removed_trip_seq = None
    if not source.stops and source is not target:
        removed_trip_seq = source.seq
        plan.trips.remove(source)

    summary = (
        f"Arrêt {station.code if station else ''} déplacé de la tournée {source.seq} (position {from_seq}) "
        f"vers la tournée {target.seq} (position {to_seq})."
    )
    if removed_trip_seq is not None:
        summary += f" La tournée {removed_trip_seq}, vide, a été supprimée."
    payload = {
        "action": "move_stop",
        "summary": summary,
        "stop_id": str(stop.id),
        "station_id": str(stop.station_id),
        "station_code": station.code if station else None,
        "from_trip_id": str(source.id),
        "from_trip_seq": source.seq,
        "from_seq": from_seq,
        "to_trip_id": str(target.id),
        "to_trip_seq": target.seq,
        "to_seq": to_seq,
        "removed_trip_seq": removed_trip_seq,
    }
    return await _finish(session, plan, payload, target.id)


def _renumber(trip: Trip) -> None:
    for index, stop in enumerate(trip.stops, start=1):
        stop.seq = index


async def reorder_stops(
    session: AsyncSession, plan_id: uuid.UUID, trip_id: uuid.UUID, stop_ids: list[uuid.UUID]
) -> Plan:
    """Réordonne les arrêts d'une tournée : `stop_ids` doit lister tous ses arrêts, une fois chacun."""
    plan, ids = await open_for_edit(session, plan_id, reason="Réordonnancement des arrêts")
    trip = find_trip(plan, ids.trip(trip_id))
    _ensure_open(trip)
    wanted = [ids.stop(s) for s in stop_ids]
    by_id: dict[uuid.UUID, Stop] = {s.id: s for s in trip.stops}
    if len(wanted) != len(set(wanted)) or set(wanted) != set(by_id):
        raise ValidationAppError(
            "La liste doit contenir tous les arrêts de la tournée, une fois chacun.",
            details=[
                {"field": "stop_ids", "message": "Liste incomplète, en double ou étrangère à la tournée."}
            ],
        )
    before = [str(s.id) for s in trip.stops]
    for index, stop_id in enumerate(wanted, start=1):
        by_id[stop_id].seq = index
    payload = {
        "action": "reorder",
        "summary": f"Arrêts de la tournée {trip.seq} réordonnés.",
        "trip_seq": trip.seq,
        "before": before,
        "after": [str(s) for s in wanted],
    }
    return await _finish(session, plan, payload, trip.id)


async def assign_resources(
    session: AsyncSession,
    plan_id: uuid.UUID,
    trip_id: uuid.UUID,
    changes: dict[str, uuid.UUID | None],
) -> Plan:
    """Change le camion et/ou le chauffeur d'une tournée. `changes` ne contient que les champs
    fournis par le client (`truck_id`, `driver_id` ; `driver_id = None` retire le chauffeur).

    Une ressource non affectable (RM-03, RM-04) est acceptée : la violation est affichée."""
    if not changes:
        raise ValidationAppError("Indiquez un camion et/ou un chauffeur.")
    truck = driver = None
    if "truck_id" in changes:
        truck = await session.get(Truck, changes["truck_id"]) if changes["truck_id"] else None
        if truck is None or truck.deleted_at is not None:
            raise NotFoundError("Camion introuvable.")
    if changes.get("driver_id"):
        driver = await session.get(Driver, changes["driver_id"])
        if driver is None or driver.deleted_at is not None:
            raise NotFoundError("Chauffeur introuvable.")

    plan, ids = await open_for_edit(session, plan_id, reason="Changement de camion ou de chauffeur")
    trip = find_trip(plan, ids.trip(trip_id))
    _ensure_open(trip)
    parts = []
    payload: dict[str, Any] = {"action": "assign", "trip_seq": trip.seq}
    if truck is not None and truck.id != trip.truck_id:
        payload.update(
            from_truck_id=str(trip.truck_id), to_truck_id=str(truck.id), to_truck_plate=truck.plate
        )
        trip.truck_id = truck.id
        parts.append(f"camion {truck.plate}")
    if "driver_id" in changes and changes["driver_id"] != trip.driver_id:
        payload.update(
            from_driver_id=str(trip.driver_id) if trip.driver_id else None,
            to_driver_id=str(driver.id) if driver else None,
            to_driver_name=driver.full_name if driver else None,
        )
        trip.driver_id = driver.id if driver else None
        parts.append(f"chauffeur {driver.full_name}" if driver else "chauffeur retiré")
    payload["summary"] = (
        f"Tournée {trip.seq} : " + (", ".join(parts) if parts else "affectation inchangée") + "."
    )
    return await _finish(session, plan, payload, trip.id)


async def set_locked(session: AsyncSession, plan_id: uuid.UUID, trip_id: uuid.UUID, locked: bool) -> Plan:
    """Verrouille ou déverrouille une tournée (F5.3, RM-17)."""
    plan, ids = await open_for_edit(
        session, plan_id, reason="Verrouillage d'une tournée" if locked else "Déverrouillage d'une tournée"
    )
    trip = find_trip(plan, ids.trip(trip_id))
    trip.locked = locked
    payload = {
        "action": "lock" if locked else "unlock",
        "summary": f"Tournée {trip.seq} {'verrouillée' if locked else 'déverrouillée'}.",
        "trip_seq": trip.seq,
    }
    await session.flush()
    log_event(session, plan, EventType.MANUAL_EDIT, payload, trip_id=trip.id)
    await session.flush()
    return await load_plan(session, plan.id)
