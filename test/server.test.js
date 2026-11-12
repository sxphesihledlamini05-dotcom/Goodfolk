const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer } = require("../server");

async function withServer(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goodfolk-test-"));
  const server = createServer({ dbPath: path.join(directory, "test.sqlite") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cookieJar = new Map();
  async function request(route, options = {}) {
    const headers = { ...options.headers };
    if (options.body) headers["Content-Type"] = "application/json";
    if (cookieJar.has(baseUrl)) headers.Cookie = cookieJar.get(baseUrl);
    const response = await fetch(`${baseUrl}${route}`, { ...options, headers, redirect: "manual" });
    const cookie = response.headers.get("set-cookie");
    if (cookie) cookieJar.set(baseUrl, cookie.split(";")[0]);
    const body = response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : null;
    return { response, body };
  }
  try {
    await run({ request, server, baseUrl });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("guest can create a community, join it, and persist the community", async () => {
  await withServer(async ({ request }) => {
    const bootstrap = await request("/api/bootstrap");
    assert.equal(bootstrap.body.guest, true);
    const created = await request("/api/communities", {
      method: "POST",
      body: JSON.stringify({
        name: "Sunday trail walkers",
        description: "An easy weekly walk and a coffee after.",
        city: "Nelspruit",
        interests: ["Hiking", "Outdoors"],
        activities: ["Sunday walks"],
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.community.joined, true);
    assert.equal(created.body.community.member_count, 1);

    const discovery = await request("/api/discover?city=Nelspruit&interest=Hiking");
    assert.equal(discovery.body.communities.length, 1);
    assert.equal(discovery.body.communities[0].name, "Sunday trail walkers");
    const search = await request("/api/discover?city=Nelspruit&q=trail");
    assert.equal(search.body.communities.length, 1);
    const escapedSearch = await request("/api/discover?city=Nelspruit&q=%25");
    assert.equal(escapedSearch.body.communities.length, 0);

    await request("/api/auth/guest", { method: "POST", body: "{}" });
    const joined = await request(`/api/communities/${created.body.community.id}/membership`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(joined.body.community.joined, true);
    assert.equal(joined.body.community.member_count, 2);
  });
});

test("guest can organize a gathering, RSVP with only a display name, and cancel", async () => {
  await withServer(async ({ request }) => {
    await request("/api/bootstrap");
    const communityResponse = await request("/api/communities", {
      method: "POST",
      body: JSON.stringify({
        name: "Local book circle",
        description: "A welcoming monthly read.",
        city: "Cape Town",
        interests: ["Books"],
        activities: [],
      }),
    });
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await request("/api/events", {
      method: "POST",
      body: JSON.stringify({
        communityId: communityResponse.body.community.id,
        name: "First chapter coffee",
        description: "Bring a book you love.",
        venue: "The neighborhood cafe",
        startsAt,
      }),
    });
    assert.equal(created.response.status, 201);
    const id = created.body.event.id;
    const filteredEvents = await request("/api/discover?city=Cape%20Town&interest=Books");
    assert.equal(filteredEvents.body.events.length, 1);
    const otherInterest = await request("/api/discover?city=Cape%20Town&interest=Hiking");
    assert.equal(otherInterest.body.events.length, 0);
    const rsvp = await request(`/api/events/${id}/rsvp`, {
      method: "POST",
      body: JSON.stringify({ displayName: "Sam" }),
    });
    assert.equal(rsvp.body.event.attending, true);
    const detail = await request(`/api/events/${id}`);
    assert.deepEqual(detail.body.attendees, [{ displayName: "Sam" }]);
    const cancelled = await request(`/api/events/${id}/rsvp`, { method: "DELETE" });
    assert.equal(cancelled.body.event.attendeeCount, 0);
  });
});

test("cross-site mutations and invalid community input are rejected", async () => {
  await withServer(async ({ request, baseUrl }) => {
    await request("/api/bootstrap");
    const crossSite = await request("/api/auth/guest", {
      method: "POST",
      headers: { Origin: "https://not-your-site.example" },
      body: "{}",
    });
    assert.equal(crossSite.response.status, 403);
    const invalid = await request("/api/communities", {
      method: "POST",
      headers: { Origin: baseUrl },
      body: JSON.stringify({
        name: "Missing interests",
        description: "This should not be saved.",
        city: "Nelspruit",
        interests: [],
      }),
    });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.body.error, /interests/i);
  });
});

test("session cookie is HTTP-only, same-site, and contains an unguessable token", async () => {
  await withServer(async ({ request }) => {
    const result = await request("/api/bootstrap");
    const cookie = result.response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const token = cookie.match(/goodfolk_session=([^;]+)/)[1];
    assert.ok(token.length >= 40);
    assert.notEqual(crypto.createHash("sha256").update(token).digest("hex"), token);
  });
});

test("LinkedIn sign-in reports missing OAuth setup rather than pretending to work", async () => {
  await withServer(async ({ request }) => {
    const result = await request("/api/auth/linkedin");
    assert.equal(result.response.status, 501);
    assert.match(result.body.error, /LINKEDIN_CLIENT_ID/);
  });
});

test("community data and guest sessions survive a server restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goodfolk-restart-"));
  const dbPath = path.join(directory, "persistent.sqlite");
  let server = createServer({ dbPath });
  let baseUrl;
  let cookie;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`);
    cookie = bootstrap.headers.get("set-cookie").split(";")[0];
    const created = await fetch(`${baseUrl}/api/communities`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Restart proof",
        description: "A durable local community.",
        city: "Durban",
        interests: ["Books"],
        activities: [],
      }),
    });
    assert.equal(created.status, 201);
    await new Promise((resolve) => server.close(resolve));
    server.database.close();

    server = createServer({ dbPath });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const discovery = await fetch(`${baseUrl}/api/discover?city=Durban`, {
      headers: { Cookie: cookie },
    });
    const result = await discovery.json();
    assert.equal(result.communities.length, 1);
    assert.equal(result.communities[0].name, "Restart proof");
    assert.equal(result.communities[0].joined, true);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    server.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("people can create and discover communities in towns outside the suggestions", async () => {
  await withServer(async ({ request }) => {
    await request("/api/bootstrap");
    const created = await request("/api/communities", {
      method: "POST",
      body: JSON.stringify({
        name: "White River classic cars",
        description: "A local meet for people who love old cars.",
        city: "White River",
        interests: ["Classic Japanese Cars"],
        activities: ["Coffee and car meets"],
      }),
    });
    assert.equal(created.response.status, 201);
    const discovery = await request("/api/discover?city=White%20River&interest=Classic%20Japanese%20Cars");
    assert.equal(discovery.body.communities.length, 1);
    assert.equal(discovery.body.communities[0].city, "White River");
  });
});
