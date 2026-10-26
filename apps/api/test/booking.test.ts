import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drainJobs } from "../src/jobs";
import { api, createAdmin, createCustomer, createTestEnv, createVehicles, resetDb, type Session, type TestEnv } from "./helpers";

let env: TestEnv;
let admin: Session;
let customer: Awaited<ReturnType<typeof createCustomer>>;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => {
  await resetDb(env.ctx);
  env.clock.now = new Date("2026-11-02T10:00:00Z");
  admin = await createAdmin(env);
  customer = await createCustomer(env);
});

const campaign = (overrides: Record<string, unknown> = {}) => ({
  name: "Testkampagne",
  startDate: "2026-11-10",
  endDate: "2026-11-30",
  vehicleCount: 2,
  secondsPerLoop: 30,
  book: true,
  ...overrides,
});

async function book(session: Session, overrides: Record<string, unknown> = {}) {
  return api(env, "POST", "/portal/campaigns", { session, body: campaign(overrides) });
}

async function availability(session: Session, startDate: string, endDate: string, secondsPerLoop: number, campaignId?: string) {
  const r = await api(env, "POST", "/portal/availability", { session, body: { startDate, endDate, secondsPerLoop, campaignId } });
  expect(r.status).toBe(200);
  return r.json.available as number;
}

async function soldSeconds(vehicleId: string, date: string): Promise<number> {
  const [r] = await env.ctx.sql<{ s: number }[]>`
    SELECT coalesce(sum(a.seconds_per_loop), 0)::int AS s FROM allocations a JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.vehicle_id = ${vehicleId} AND a.period @> ${date}::date AND c.status IN ('booked', 'paused', 'ended')
  `;
  return r!.s;
}

describe("Verfügbarkeit und Buchung", () => {
  it("zeigt freie Fahrzeuge und verteilt die Buchung", async () => {
    await createVehicles(env, admin, 3);
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 30)).toBe(3);
    const r = await book(customer.session);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "booked", phase: "scheduled", vehicleCount: 2 });
    const detail = await api(env, "GET", `/admin/campaigns/${r.json.id}`, { session: admin });
    expect(detail.json.allocations).toHaveLength(2);
    expect(detail.json.allocations[0]).toMatchObject({ startDate: "2026-11-10", endDate: "2026-11-30", secondsPerLoop: 30 });
  });

  it("verkauft pro Fahrzeug höchstens die volle Schleife (300 s)", async () => {
    const [v1, v2] = await createVehicles(env, admin, 2);
    expect((await book(customer.session, { secondsPerLoop: 60, vehicleCount: 2 })).status).toBe(201);
    expect((await book(customer.session, { secondsPerLoop: 60, vehicleCount: 2 })).status).toBe(201);
    expect((await book(customer.session, { secondsPerLoop: 60, vehicleCount: 2 })).status).toBe(201);
    expect((await book(customer.session, { secondsPerLoop: 60, vehicleCount: 2 })).status).toBe(201);
    // 240 s verkauft, 60 s frei
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 60)).toBe(2);
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 65)).toBe(0);
    const tooMuch = await book(customer.session, { secondsPerLoop: 60, vehicleCount: 3 });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.json).toMatchObject({ error: "insufficient_capacity", details: { available: 2, requested: 3 } });
    expect((await book(customer.session, { secondsPerLoop: 60, vehicleCount: 2 })).status).toBe(201);
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 5)).toBe(0);
    expect(await soldSeconds(v1!, "2026-11-15")).toBe(300);
    expect(await soldSeconds(v2!, "2026-11-15")).toBe(300);
    // Außerhalb des Zeitraums ist alles frei.
    expect(await availability(customer.session, "2026-12-01", "2026-12-31", 60)).toBe(2);
    // Teilweise Überschneidung zählt als belegt.
    expect(await availability(customer.session, "2026-11-30", "2026-12-05", 60)).toBe(0);
  });

  it("gleichzeitige Buchungen überbuchen nicht", async () => {
    const vehicles = await createVehicles(env, admin, 3);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => book(customer.session, { secondsPerLoop: 60, vehicleCount: 1, name: "Parallel" })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    // 3 Fahrzeuge × 5 Buchungen à 60 s = 15 passen, 8 Anfragen -> alle ok
    expect(ok).toBe(8);
    const more = await Promise.all(
      Array.from({ length: 10 }, () => book(customer.session, { secondsPerLoop: 60, vehicleCount: 1, name: "Parallel 2" })),
    );
    expect(more.filter((r) => r.status === 201).length).toBe(7);
    expect(more.filter((r) => r.status === 409).length).toBe(3);
    for (const v of vehicles) expect(await soldSeconds(v, "2026-11-20")).toBe(300);
  });

  it("prüft Mindest-, Höchstdauer, Schrittweite und Starttag", async () => {
    await createVehicles(env, admin, 1);
    expect((await book(customer.session, { secondsPerLoop: 3 })).status).toBe(400);
    expect((await book(customer.session, { secondsPerLoop: 90 })).status).toBe(400);
    expect((await book(customer.session, { secondsPerLoop: 12 })).status).toBe(400);
    expect((await book(customer.session, { startDate: "2026-11-01" })).status).toBe(400); // gestern
    expect((await book(customer.session, { startDate: "2026-11-20", endDate: "2026-11-10" })).status).toBe(400);
    // Grenzen sind im Admin einstellbar
    await api(env, "PATCH", "/admin/settings", { session: admin, body: { bookingMaxSeconds: 120, bookingStepSeconds: 1 } });
    expect((await book(customer.session, { secondsPerLoop: 90, vehicleCount: 1 })).status).toBe(201);
  });

  it("Entwurf belegt keine Kapazität, erst die Buchung", async () => {
    await createVehicles(env, admin, 1);
    const draft = await book(customer.session, { book: false, secondsPerLoop: 60, vehicleCount: 1 });
    expect(draft.json.status).toBe("draft");
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 300)).toBe(1);
    const booked = await api(env, "POST", `/portal/campaigns/${draft.json.id}/book`, { session: customer.session });
    expect(booked.json.status).toBe("booked");
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 300)).toBe(0);
  });
});

describe("Kampagnen ändern, pausieren, beenden", () => {
  it("Pause behält die Kapazität, Fortsetzen ist jederzeit möglich", async () => {
    await createVehicles(env, admin, 1);
    const c = await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1 });
    const paused = await api(env, "POST", `/portal/campaigns/${c.json.id}/pause`, { session: customer.session });
    expect(paused.json).toMatchObject({ status: "paused", phase: "paused" });
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 260)).toBe(0);
    const resumed = await api(env, "POST", `/portal/campaigns/${c.json.id}/resume`, { session: customer.session });
    expect(resumed.json.status).toBe("booked");
  });

  it("Stornieren vor Start gibt die Kapazität komplett frei", async () => {
    await createVehicles(env, admin, 1);
    const c = await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1 });
    const ended = await api(env, "POST", `/portal/campaigns/${c.json.id}/end`, { session: customer.session });
    expect(ended.json).toMatchObject({ status: "cancelled", phase: "cancelled" });
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 300)).toBe(1);
  });

  it("Beenden einer laufenden Kampagne gibt ab morgen frei, die Vergangenheit bleibt", async () => {
    const [v] = await createVehicles(env, admin, 1);
    const c = await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1 });
    env.clock.now = new Date("2026-11-15T10:00:00Z");
    expect((await api(env, "GET", `/portal/campaigns/${c.json.id}`, { session: customer.session })).json.phase).toBe("running");
    const ended = await api(env, "POST", `/portal/campaigns/${c.json.id}/end`, { session: customer.session });
    expect(ended.json).toMatchObject({ status: "ended", phase: "completed", endDate: "2026-11-15" });
    expect(await soldSeconds(v!, "2026-11-12")).toBe(60);
    expect(await soldSeconds(v!, "2026-11-15")).toBe(60);
    expect(await soldSeconds(v!, "2026-11-16")).toBe(0);
    // Beendete Kampagnen lassen sich nicht mehr ändern
    const edit = await api(env, "PATCH", `/portal/campaigns/${c.json.id}`, {
      session: customer.session,
      body: { secondsPerLoop: 30 },
    });
    expect(edit.status).toBe(409);
  });

  it("Erhöhen von Sekunden und Fahrzeugen prüft die Verfügbarkeit erneut", async () => {
    await createVehicles(env, admin, 2);
    const other = await createCustomer(env, "Konkurrenz");
    await book(other.session, { secondsPerLoop: 60, vehicleCount: 2 }); // je 240 s frei
    const c = await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1 });
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 240, c.json.id)).toBe(2);

    const tooMuch = await api(env, "PATCH", `/portal/campaigns/${c.json.id}`, {
      session: customer.session,
      body: { vehicleCount: 3 },
    });
    expect(tooMuch.status).toBe(409);

    const more = await api(env, "PATCH", `/portal/campaigns/${c.json.id}`, {
      session: customer.session,
      body: { vehicleCount: 2, secondsPerLoop: 60 },
    });
    expect(more.status).toBe(200);
    expect(more.json.vehicleCount).toBe(2);
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 185)).toBe(0);
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 180)).toBe(2);
  });

  it("laufende Kampagne: Start ist fix, Änderungen gelten ab heute", async () => {
    const [v] = await createVehicles(env, admin, 1);
    const c = await book(customer.session, { secondsPerLoop: 30, vehicleCount: 1 });
    env.clock.now = new Date("2026-11-20T10:00:00Z");
    const badStart = await api(env, "PATCH", `/portal/campaigns/${c.json.id}`, {
      session: customer.session,
      body: { startDate: "2026-11-21" },
    });
    expect(badStart.status).toBe(400);
    const r = await api(env, "PATCH", `/portal/campaigns/${c.json.id}`, {
      session: customer.session,
      body: { secondsPerLoop: 45, endDate: "2026-12-10" },
    });
    expect(r.status).toBe(200);
    expect(await soldSeconds(v!, "2026-11-19")).toBe(30);
    expect(await soldSeconds(v!, "2026-11-20")).toBe(45);
    expect(await soldSeconds(v!, "2026-12-10")).toBe(45);
  });

  it("verringerte Schleifenlänge (Richtwert): bestehende Buchungen bleiben, neue werden begrenzt", async () => {
    await createVehicles(env, admin, 1);
    await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1 });
    await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1 });
    await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1 });
    expect((await api(env, "PATCH", "/admin/settings", { session: admin, body: { loopSeconds: 150 } })).status).toBe(200);
    expect(await availability(customer.session, "2026-11-10", "2026-11-30", 5)).toBe(0);
    const campaigns = await api(env, "GET", "/portal/campaigns", { session: customer.session });
    expect(campaigns.json.filter((c: { status: string }) => c.status === "booked")).toHaveLength(3);
  });
});

describe("Auslastung im Admin-Bereich", () => {
  it("zeigt verkaufte Sekunden je Fahrzeug", async () => {
    await createVehicles(env, admin, 2);
    await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1, startDate: "2026-11-10", endDate: "2026-11-11" });
    const r = await api(env, "GET", "/admin/utilization", { session: admin, query: { from: "2026-11-09", to: "2026-11-12" } });
    expect(r.status).toBe(200);
    const peaks = r.json.vehicles.map((v: { peakSeconds: number }) => v.peakSeconds).sort();
    expect(peaks).toEqual([0, 60]);
    const busy = r.json.vehicles.find((v: { peakSeconds: number }) => v.peakSeconds === 60);
    expect(busy.days).toEqual([0, 60, 60, 0]);
  });
});

describe("Playlists", () => {
  it("Buchung löst Neuaufbau der Playlists der betroffenen Fahrzeuge aus", async () => {
    const [v] = await createVehicles(env, admin, 1);
    await drainJobs(env.ctx);
    const before = await api(env, "GET", `/admin/vehicles/${v}/playlist`, { session: admin });
    expect(before.json.version).toBe(1);
    expect(before.json.days).toHaveLength(7);
    expect(before.json.days[0]).toMatchObject({ date: "2026-11-02", loopMs: 300_000 });
    await book(customer.session, { secondsPerLoop: 60, vehicleCount: 1, startDate: "2026-11-03" });
    await drainJobs(env.ctx);
    const after = await api(env, "GET", `/admin/vehicles/${v}/playlist`, { session: admin });
    // Noch kein freigegebenes Motiv -> Inhalt gleich -> keine neue Version
    expect(after.json.version).toBe(1);
  });
});
