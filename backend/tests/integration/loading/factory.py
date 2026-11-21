"""Fabrique de test : un plan avec une tournée complète, créé directement par l'ORM.

(Les plans sont normalement produits par le service de plans — lot L5.)

Scénario par défaut, jour J = 12/01/2027 :
- dépôt SCDP-DLA, camion LT-123-AB à 3 compartiments (10 000 / 10 000 / 5 000 L), un chauffeur ;
- arrêt 1 : station ST-001 — commandes Super 10 000 L et Gasoil 5 000 L ;
- arrêt 2 : station ST-002 — commande Super 10 000 L ;
- plan de chargement : compartiment 1 Super 10 000, compartiment 2 Super 10 000, compartiment 3 Gasoil 5 000.
"""

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.enums import OrderStatus, PlanStatus, TripStatus, TruckSize
from app.core.geo import point
from app.orders.models import Order
from app.planning.models import Plan, Stop, StopDelivery, Trip, TripCompartmentLoad
from app.referentials.models import Depot, Driver, Product, Station, Truck, TruckCompartment

DAY = date(2027, 1, 12)


def at(hour: int, minute: int = 0, day: date = DAY) -> datetime:
    """Horodatage UTC du jour J."""
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=UTC)


def iso(moment: datetime) -> str:
    return moment.isoformat().replace("+00:00", "Z")


@dataclass
class TripScenario:
    plan: Plan
    trip: Trip
    depot: Depot
    truck: Truck
    driver: Driver
    compartments: list[TruckCompartment]
    stations: list[Station]
    stops: list[Stop]
    orders: list[Order]
    products: dict[str, Product]
    extra: dict = field(default_factory=dict)

    def loading_payload(self, **overrides) -> dict:
        """Chargement conforme au plan, à 15 °C (donc volume à 15 °C = volume observé)."""
        c1, c2, c3 = self.compartments
        payload = {
            "arrived_at": iso(at(5, 0)),
            "started_at": iso(at(6, 30)),
            "finished_at": iso(at(7, 15)),
            "depot_ticket_no": "BL-2027-0042",
            "lines": [
                self.line(c1, "SUPER", 10000, 15),
                self.line(c2, "SUPER", 10000, 15),
                self.line(c3, "GASOIL", 5000, 15, density=0.8451),
            ],
        }
        payload.update(overrides)
        return payload

    def line(self, compartment, product_code, observed_l, temp_c, density=None) -> dict:
        return {
            "compartment_id": str(compartment.id),
            "product_id": str(self.products[product_code].id),
            "observed_l": observed_l,
            "observed_temp_c": temp_c,
            "observed_density": density,
        }


async def make_trip_scenario(
    db: AsyncSession,
    products: dict[str, Product],
    *,
    plan_status: PlanStatus = PlanStatus.PUBLISHED,
    trip_status: TripStatus = TripStatus.PLANNED,
    day: date = DAY,
    suffix: str = "",
    depot: Depot | None = None,
    station_emails: tuple[str | None, str | None] = ("gerant.akwa@example.cm", "gerant.bonaberi@example.cm"),
) -> TripScenario:
    if depot is None:
        depot = Depot(code=f"SCDP-DLA{suffix}", name="SCDP Douala", location=point(4.0483, 9.7043))
        db.add(depot)
    truck = Truck(
        plate=f"LT-123-AB{suffix}",
        size=TruckSize.LARGE,
        total_capacity_l=Decimal("25000"),
        compartments=[
            TruckCompartment(position=1, capacity_l=Decimal("10500")),
            TruckCompartment(position=2, capacity_l=Decimal("10500")),
            TruckCompartment(position=3, capacity_l=Decimal("5500")),
        ],
    )
    driver = Driver(full_name="Jean Mbarga", phone="+237 677 00 00 01", license_no=f"P-0001{suffix}")
    stations = [
        Station(
            code=f"ST-001{suffix}",
            name="OLA Akwa",
            city="Douala",
            location=point(4.05, 9.70),
            contact_name="Mme Ngo",
            contact_phone="+237 699 00 00 02",
            contact_email=station_emails[0],
        ),
        Station(
            code=f"ST-002{suffix}",
            name="OLA Bonabéri",
            city="Douala",
            location=point(4.07, 9.67),
            contact_email=station_emails[1],
        ),
    ]
    db.add_all([truck, driver, *stations])
    await db.flush()

    def order(station: Station, code: str, liters: str) -> Order:
        return Order(
            day=day,
            station_id=station.id,
            product_id=products[code].id,
            requested_l=Decimal(liters),
            status=OrderStatus.PLANNED,
        )

    orders = [
        order(stations[0], "SUPER", "10000"),
        order(stations[0], "GASOIL", "5000"),
        order(stations[1], "SUPER", "10000"),
    ]
    plan = Plan(day=day, status=plan_status, version=1)
    db.add_all([*orders, plan])
    await db.flush()

    c1, c2, c3 = truck.compartments

    def delivery(o: Order) -> StopDelivery:
        return StopDelivery(order_id=o.id, product_id=o.product_id, planned_l=o.requested_l)

    stops = [
        Stop(
            seq=1,
            station_id=stations[0].id,
            planned_arrival_at=at(8, 30, day),
            planned_departure_at=at(9, 15, day),
            distance_from_prev_m=12000,
            deliveries=[delivery(orders[0]), delivery(orders[1])],
        ),
        Stop(
            seq=2,
            station_id=stations[1].id,
            planned_arrival_at=at(9, 45, day),
            planned_departure_at=at(10, 30, day),
            distance_from_prev_m=8000,
            deliveries=[delivery(orders[2])],
        ),
    ]
    trip = Trip(
        plan_id=plan.id,
        seq=1,
        truck_id=truck.id,
        driver_id=driver.id,
        depot_id=depot.id,
        planned_start_at=at(5, 0, day),
        planned_depart_at=at(7, 15, day),
        planned_return_at=at(11, 30, day),
        distance_m=42000,
        duration_s=15300,
        status=trip_status,
        stops=stops,
        compartment_loads=[
            TripCompartmentLoad(
                compartment_id=c1.id, product_id=products["SUPER"].id, planned_l=Decimal("10000")
            ),
            TripCompartmentLoad(
                compartment_id=c2.id, product_id=products["SUPER"].id, planned_l=Decimal("10000")
            ),
            TripCompartmentLoad(
                compartment_id=c3.id, product_id=products["GASOIL"].id, planned_l=Decimal("5000")
            ),
        ],
    )
    db.add(trip)
    await db.flush()
    return TripScenario(
        plan=plan,
        trip=trip,
        depot=depot,
        truck=truck,
        driver=driver,
        compartments=[c1, c2, c3],
        stations=stations,
        stops=stops,
        orders=orders,
        products=products,
    )
