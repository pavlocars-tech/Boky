import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, createAdmin, createCustomer, createTestEnv, login, resetDb, tokenFromMail, type TestEnv } from "./helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => env.close());
beforeEach(async () => resetDb(env.ctx));

describe("Registrierung und Anmeldung", () => {
  it("Kunde registriert sich, muss die E-Mail bestätigen und kann sich dann anmelden", async () => {
    const body = {
      companyName: "Café Central",
      name: "Franz Wagner",
      email: "franz@cafe.at",
      password: "sehr-geheim-123",
      acceptTerms: true,
    };
    expect((await api(env, "POST", "/auth/register", { body })).status).toBe(201);

    const early = await api(env, "POST", "/auth/login", { body: { email: "franz@cafe.at", password: "sehr-geheim-123" } });
    expect(early.status).toBe(403);
    expect(early.json.error).toBe("email_not_verified");

    const token = tokenFromMail(env.mailer.last("franz@cafe.at")!.text);
    expect((await api(env, "POST", "/auth/verify-email", { body: { token } })).status).toBe(200);
    // Link nur einmal verwendbar
    expect((await api(env, "POST", "/auth/verify-email", { body: { token } })).status).toBe(400);

    const session = await login(env, "franz@cafe.at", "sehr-geheim-123");
    const me = await api(env, "GET", "/auth/me", { session });
    expect(me.json.user).toMatchObject({ email: "franz@cafe.at", role: "customer", customerRole: "owner" });
  });

  it("falsches Passwort und unbekannte E-Mail geben dieselbe Meldung", async () => {
    await createCustomer(env, "Firma", "a@example.com");
    const wrong = await api(env, "POST", "/auth/login", { body: { email: "a@example.com", password: "falsch-falsch" } });
    const unknown = await api(env, "POST", "/auth/login", { body: { email: "nobody@example.com", password: "falsch-falsch" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.message).toBe(unknown.json.message);
  });

  it("doppelte Registrierung verrät nicht, dass das Konto existiert", async () => {
    await createCustomer(env, "Firma", "dup@example.com");
    const again = await api(env, "POST", "/auth/register", {
      body: { companyName: "Firma XY", name: "Y Z", email: "dup@example.com", password: "irgendwas-123", acceptTerms: true },
    });
    expect(again.status).toBe(201);
    expect(env.mailer.last("dup@example.com")!.subject).toContain("bereits vorhanden");
  });

  it("Passwort zurücksetzen meldet alle Sitzungen ab", async () => {
    const c = await createCustomer(env, "Firma", "reset@example.com");
    await api(env, "POST", "/auth/password-reset/request", { body: { email: "reset@example.com" } });
    const token = tokenFromMail(env.mailer.last("reset@example.com")!.text);
    expect(
      (await api(env, "POST", "/auth/password-reset/confirm", { body: { token, password: "neues-passwort-456" } })).status,
    ).toBe(200);
    expect((await api(env, "GET", "/auth/me", { session: c.session })).status).toBe(401);
    await login(env, "reset@example.com", "neues-passwort-456");
  });

  it("Sitzung mit Cookie von fremder Herkunft wird abgewiesen (CSRF)", async () => {
    const c = await createCustomer(env);
    const res = await env.app.inject({
      method: "POST",
      url: "/portal/campaigns",
      headers: { cookie: c.session.cookie, origin: "https://boese.example" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Mitarbeiter eines Kunden", () => {
  it("Inhaber lädt Mitarbeiter ein; Mitarbeiter sieht dieselben Kampagnen, darf aber niemanden einladen", async () => {
    const owner = await createCustomer(env, "Autohaus Gruber");
    const inv = await api(env, "POST", "/portal/team/invitations", {
      session: owner.session,
      body: { email: "mitarbeiter@gruber.at", name: "Lisa Gruber" },
    });
    expect(inv.status).toBe(201);
    const token = tokenFromMail(env.mailer.last("mitarbeiter@gruber.at")!.text);
    const accept = await env.app.inject({
      method: "POST",
      url: "/auth/invitation/accept",
      payload: { token, password: "mitarbeiter-123" },
    });
    expect(accept.statusCode).toBe(200);
    const member = await login(env, "mitarbeiter@gruber.at", "mitarbeiter-123");

    const me = await api(env, "GET", "/auth/me", { session: member });
    expect(me.json.user).toMatchObject({ customerId: owner.customerId, customerRole: "member" });

    const team = await api(env, "GET", "/portal/team", { session: member });
    expect(team.json).toHaveLength(2);
    const forbidden = await api(env, "POST", "/portal/team/invitations", {
      session: member,
      body: { email: "x@gruber.at", name: "X Y" },
    });
    expect(forbidden.status).toBe(403);
  });

  it("der letzte Inhaber kann sich nicht selbst herabstufen", async () => {
    const owner = await createCustomer(env);
    const r = await api(env, "PATCH", `/portal/team/${owner.userId}`, { session: owner.session, body: { role: "member" } });
    expect(r.status).toBe(409);
  });
});

describe("Rollen und Mandantentrennung", () => {
  it("Kunden sehen ausschließlich eigene Daten", async () => {
    const a = await createCustomer(env, "Kunde A");
    const b = await createCustomer(env, "Kunde B");
    const created = await api(env, "POST", "/portal/campaigns", {
      session: a.session,
      body: { name: "Herbstaktion", startDate: "2026-11-10", endDate: "2026-11-20", vehicleCount: 1, secondsPerLoop: 10 },
    });
    expect(created.status).toBe(201);
    const id = created.json.id;

    expect((await api(env, "GET", "/portal/campaigns", { session: b.session })).json).toEqual([]);
    expect((await api(env, "GET", `/portal/campaigns/${id}`, { session: b.session })).status).toBe(404);
    expect((await api(env, "PATCH", `/portal/campaigns/${id}`, { session: b.session, body: { name: "gehackt" } })).status).toBe(
      404,
    );
    expect((await api(env, "POST", `/portal/campaigns/${id}/end`, { session: b.session })).status).toBe(404);
    expect((await api(env, "GET", `/portal/campaigns/${id}/creatives`, { session: b.session })).status).toBe(404);
    expect(
      (
        await api(env, "POST", `/portal/campaigns/${id}/creatives`, {
          session: b.session,
          body: { filename: "x.jpg", mimeType: "image/jpeg", sizeBytes: 1000 },
        })
      ).status,
    ).toBe(404);
    expect((await api(env, "GET", `/portal/campaigns/${id}`, { session: a.session })).status).toBe(200);
  });

  it("Kunden haben keinen Zugriff auf den Admin-Bereich, Gäste auf nichts", async () => {
    const c = await createCustomer(env);
    for (const url of ["/admin/vehicles", "/admin/devices", "/admin/settings", "/admin/customers"]) {
      expect((await api(env, "GET", url, { session: c.session })).status).toBe(403);
      expect((await api(env, "GET", url)).status).toBe(401);
    }
    expect((await api(env, "GET", "/portal/campaigns")).status).toBe(401);
  });

  it("Admin darf nicht ins Kundenportal, sieht aber alle Kampagnen im Admin-Bereich", async () => {
    const admin = await createAdmin(env);
    const c = await createCustomer(env);
    await api(env, "POST", "/portal/campaigns", {
      session: c.session,
      body: { name: "K1", startDate: "2026-11-10", endDate: "2026-11-20", vehicleCount: 1, secondsPerLoop: 10 },
    });
    expect((await api(env, "GET", "/portal/campaigns", { session: admin })).status).toBe(403);
    const all = await api(env, "GET", "/admin/campaigns", { session: admin });
    expect(all.json).toHaveLength(1);
  });

  it("gesperrte Kunden werden sofort abgemeldet", async () => {
    const admin = await createAdmin(env);
    const c = await createCustomer(env);
    await api(env, "PATCH", `/admin/customers/${c.customerId}`, { session: admin, body: { status: "blocked" } });
    expect((await api(env, "GET", "/auth/me", { session: c.session })).status).toBe(401);
    const relogin = await api(env, "POST", "/auth/login", { body: { email: c.email, password: c.password } });
    expect(relogin.status).toBe(403);
  });
});
