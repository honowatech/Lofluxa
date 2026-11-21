import { describe, expect, it } from "vitest";

import {
  addDays,
  dayBoundsUtc,
  daysUntil,
  EMPTY,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatDuration,
  formatKm,
  formatLiters,
  formatLocalTime,
  formatNumber,
  formatPercent,
  formatSeconds,
  formatSigned,
  formatSignedPercent,
  hmToSeconds,
  isValidDay,
  parseDecimal,
  secondsToHM,
  todayLocal,
} from "./format";

const nbsp = (text: string) => text.replace(/ /g, " ");

describe("formatage", () => {
  it("formatLiters : milliers groupés, unité L, arrondi au litre", () => {
    expect(formatLiters(12000)).toBe(nbsp("12 000 L"));
    expect(formatLiters(1234567.6)).toBe(nbsp("1 234 568 L"));
    expect(formatLiters(0)).toBe(nbsp("0 L"));
    expect(formatLiters(null)).toBe(EMPTY);
    expect(formatLiters(undefined)).toBe(EMPTY);
  });

  it("formatKm : reçoit des mètres, une décimale sous 100 km", () => {
    expect(formatKm(12400)).toBe(nbsp("12,4 km"));
    expect(formatKm(412530)).toBe(nbsp("413 km"));
    expect(formatKm(1234000)).toBe(nbsp("1 234 km"));
    expect(formatKm(null)).toBe(EMPTY);
  });

  it("formatDuration : reçoit des secondes", () => {
    expect(formatDuration(45 * 60)).toBe(nbsp("45 min"));
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe(nbsp("2 h 05"));
    expect(formatDuration(11 * 3600)).toBe(nbsp("11 h 00"));
    expect(formatDuration(-600)).toBe(nbsp("−10 min"));
    expect(formatDuration(null)).toBe(EMPTY);
  });

  it("formatDuration : secondes sous la minute sur option (défaut inchangé)", () => {
    expect(formatDuration(42)).toBe(nbsp("1 min"));
    expect(formatDuration(42, { seconds: true })).toBe(nbsp("42 s"));
    expect(formatDuration(-8, { seconds: true })).toBe(nbsp("−8 s"));
    expect(formatDuration(0, { seconds: true })).toBe(nbsp("0 s"));
    expect(formatDuration(60, { seconds: true })).toBe(nbsp("1 min"));
    expect(formatDuration(7500, { seconds: true })).toBe(nbsp("2 h 05"));
  });

  it("formatSeconds : durée courte avec décimales", () => {
    expect(formatSeconds(5.34)).toBe(nbsp("5,3 s"));
    expect(formatSeconds(0.25, 2)).toBe(nbsp("0,25 s"));
    expect(formatSeconds(45, 0)).toBe(nbsp("45 s"));
    expect(formatSeconds(null)).toBe(EMPTY);
  });

  it("formatSigned, formatSignedPercent : écarts avec signe typographique", () => {
    expect(formatSigned(1250)).toBe(nbsp("+1 250"));
    expect(formatSigned(-3.5, 1)).toBe("−3,5");
    expect(formatSigned(0)).toBe("0");
    expect(formatSigned(-0.004, 2)).toBe("0,00");
    expect(formatSigned(-120, 0, "L")).toBe(nbsp("−120 L"));
    expect(formatSigned(null)).toBe(EMPTY);
    expect(formatSignedPercent(1.84, 2)).toBe(nbsp("+1,84 %"));
    expect(formatSignedPercent(-100)).toBe(nbsp("−100 %"));
    expect(formatSignedPercent(undefined)).toBe(EMPTY);
  });

  it("formatLocalTime : HH:mm en heure de Douala (UTC+1), RM-20", () => {
    expect(formatLocalTime("2027-01-12T06:30:00Z")).toBe("07:30");
    expect(formatLocalTime("2027-01-12T23:45:00Z")).toBe("00:45");
    expect(formatLocalTime(new Date("2027-07-01T12:00:00Z"))).toBe("13:00");
    expect(formatLocalTime(null)).toBe(EMPTY);
    expect(formatLocalTime("pas une date")).toBe(EMPTY);
  });

  it("formatDate : date seule inchangée, horodatage ramené au jour de Douala", () => {
    expect(formatDate("2027-01-12")).toBe("12/01/2027");
    expect(formatDate("2027-01-12T23:30:00Z")).toBe("13/01/2027");
    expect(formatDateTime("2027-01-12T06:30:00Z")).toBe("12/01/2027 07:30");
    expect(formatDateLong("2027-01-12")).toBe("mar. 12 janv. 2027");
    expect(formatDate(null)).toBe(EMPTY);
  });

  it("nombres et pourcentages", () => {
    expect(formatNumber(0.8452, 4)).toBe("0,8452");
    expect(formatNumber(1500)).toBe(nbsp("1 500"));
    expect(formatPercent(12.34, 1)).toBe(nbsp("12,3 %"));
    expect(formatNumber(Number.NaN)).toBe(EMPTY);
  });

  it("jours : aujourd'hui à Douala, décalages, validité", () => {
    expect(todayLocal(new Date("2027-01-12T23:30:00Z"))).toBe("2027-01-13");
    expect(todayLocal(new Date("2027-01-12T22:30:00Z"))).toBe("2027-01-12");
    expect(addDays("2027-01-31", 1)).toBe("2027-02-01");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(daysUntil("2027-01-20", "2027-01-12")).toBe(8);
    expect(daysUntil("2027-01-10", "2027-01-12")).toBe(-2);
    expect(isValidDay("2027-02-30")).toBe(false);
    expect(isValidDay("2027-02-28")).toBe(true);
    expect(isValidDay("12/01/2027")).toBe(false);
    expect(dayBoundsUtc("2027-01-12")).toEqual({
      from: "2027-01-11T23:00:00.000Z",
      to: "2027-01-12T23:00:00.000Z",
    });
  });

  it("heures et saisies", () => {
    expect(hmToSeconds("06:30")).toBe(23400);
    expect(secondsToHM(23400)).toBe("06:30");
    expect(secondsToHM(25 * 3600)).toBe("25:00");
    expect(parseDecimal("12 000")).toBe(12000);
    expect(parseDecimal("12 000,5")).toBe(12000.5);
    expect(parseDecimal("0.845")).toBe(0.845);
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });
});
