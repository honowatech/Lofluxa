"""Aides des tests d'import : fabrication de fichiers xlsx / csv en mémoire et appels de l'API."""

import csv
import io

from openpyxl import Workbook


def xlsx(headers: list[str], rows: list[list], sheet: str = "Données") -> bytes:
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = sheet
    worksheet.append(headers)
    for row in rows:
        worksheet.append(row)
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def csv_file(
    headers: list[str], rows: list[list], delimiter: str = ";", encoding: str = "utf-8-sig"
) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=delimiter)
    writer.writerow(headers)
    for row in rows:
        writer.writerow(["" if value is None else value for value in row])
    return buffer.getvalue().encode(encoding)


async def preview(client, headers, kind: str, content: bytes, filename: str | None = None, **params):
    filename = filename or f"{kind}.xlsx"
    return await client.post(
        f"/imports/{kind}/preview", files={"file": (filename, content)}, params=params, headers=headers
    )


async def apply(client, headers, batch: dict):
    return await client.post(f"/imports/{batch['id']}/apply", headers=headers)


def issues(batch: dict, severity: str = "error") -> list[tuple]:
    """(ligne, colonne) des anomalies d'un rapport, pour des assertions lisibles."""
    return [(i["row"], i["column"]) for i in batch["report"]["issues"] if i["severity"] == severity]


def changes(item: dict) -> dict:
    return {c["field"]: (c["before"], c["after"]) for c in item["changes"]}
