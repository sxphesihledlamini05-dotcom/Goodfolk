const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const CITIES = [
  "Nelspruit",
  "Johannesburg",
  "Cape Town",
  "Durban",
  "Pretoria",
  "Gqeberha",
];
const INTERESTS = [
  "Rugby",
  "Soccer",
  "Fitness",
  "Hiking",
  "Gaming",
  "Books",
  "Music",
  "Photography",
  "Entrepreneurship",
  "Cars",
  "Outdoors",
];
const COOKIE_NAME = "goodfolk_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function createDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      linkedin_sub TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      city TEXT NOT NULL,
      interests TEXT NOT NULL,
      activities TEXT NOT NULL,
      organizer_id TEXT NOT NULL REFERENCES visitors(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (community_id, visitor_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      venue TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES visitors(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rsvps (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, visitor_id)
    );
    CREATE INDEX IF NOT EXISTS communities_city_idx ON communities(city);
    CREATE INDEX IF NOT EXISTS events_starts_at_idx ON events(starts_at);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
  `);
  return db;
}

function createServer(options = {}) {
  const db = createDatabase(
    options.dbPath || process.env.DATABASE_PATH || path.join(__dirname, "goodfolk.sqlite"),
  );
  const publicDir = options.publicDir || path.join(__dirname, "public");
  const env = options.env || process.env;

  function json(res, status, payload, headers = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    res.end(JSON.stringify(payload));
  }

  function setSessionCookie(res, token, maxAge = SESSION_TTL_MS / 1000) {
    const secure = env.NODE_ENV === "production" ? "; Secure" : "";
    appendSetCookie(
      res,
      `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`,
    );
  }

  function appendSetCookie(res, value) {
    const current = res.getHeader("Set-Cookie");
    res.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [current]), value] : value);
  }

  function createVisitor(displayName = null, linkedinSub = null) {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO visitors (id, display_name, linkedin_sub, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, displayName, linkedinSub, new Date().toISOString());
    return { id, displayName, linkedinSub };
  }

  function createSession(visitorId, res) {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    db.prepare("INSERT INTO sessions (token_hash, visitor_id, expires_at) VALUES (?, ?, ?)")
      .run(tokenHash, visitorId, Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token);
  }

  function readSession(req, res) {
    const cookieHeader = req.headers.cookie || "";
    const cookieValue = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    if (cookieValue) {
      const tokenHash = crypto.createHash("sha256").update(cookieValue).digest("hex");
      const session = db
        .prepare(
          `SELECT visitors.id, visitors.display_name, visitors.linkedin_sub
           FROM sessions JOIN visitors ON visitors.id = sessions.visitor_id
           WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
        )
        .get(tokenHash, Date.now());
      if (session) return session;
    }

    const visitor = createVisitor();
    createSession(visitor.id, res);
    return visitor;
  }

  function revokeCurrentSession(req) {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    if (token) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    }
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 64) {
          tooLarge = true;
          reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        }
      });
      req.on("end", () => {
        if (tooLarge) return;
        try {
          resolve(JSON.parse(body || "{}"));
        } catch {
          reject(Object.assign(new Error("Send a valid JSON request."), { status: 400 }));
        }
      });
      req.on("error", reject);
    });
  }

  function requireText(value, label, maxLength) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
      throw Object.assign(new Error(`${label} is required and must be at most ${maxLength} characters.`), {
        status: 400,
      });
    }
    return value.trim();
  }

  function findCommunity(id, visitorId) {
    return db
      .prepare(
        `SELECT c.id, c.name, c.description, c.city, c.interests, c.activities,
                organizer.display_name AS organizer,
                EXISTS(SELECT 1 FROM memberships m
                       WHERE m.community_id = c.id AND m.visitor_id = ?) AS joined,
                (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id) AS member_count
         FROM communities c JOIN visitors organizer ON organizer.id = c.organizer_id
         WHERE c.id = ?`,
      )
      .get(visitorId, id);
  }

  function mapCommunity(row) {
    return {
      ...row,
      interests: JSON.parse(row.interests),
      activities: JSON.parse(row.activities),
      joined: Boolean(row.joined),
      organizer: row.organizer || "Community organizer",
    };
  }

  function findEvent(id, visitorId) {
    return db
      .prepare(
        `SELECT e.id, e.name, e.description, e.venue, e.starts_at AS startsAt,
                c.id AS community_id, c.name AS community_name, c.city,
                (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS attendee_count,
                EXISTS(SELECT 1 FROM rsvps r
                       WHERE r.event_id = e.id AND r.visitor_id = ?) AS attending
         FROM events e JOIN communities c ON c.id = e.community_id
         WHERE e.id = ?`,
      )
      .get(visitorId, id);
  }

  function mapEvent(row) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      venue: row.venue,
      startsAt: row.startsAt,
      community: { id: row.community_id, name: row.community_name },
      city: row.city,
      attendeeCount: row.attendee_count,
      attending: Boolean(row.attending),
    };
  }

  function verifyRequestOrigin(req) {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      throw Object.assign(new Error("Cross-site requests are not allowed."), { status: 403 });
    }
    const origin = req.headers.origin;
    if (origin && req.headers.host) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
        }
      } catch (error) {
        if (error.status) throw error;
        throw Object.assign(new Error("Invalid request origin."), { status: 403 });
      }
    }
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    if (req.method !== "GET") {
      verifyRequestOrigin(req);
      if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json")) {
        throw Object.assign(new Error("Content-Type must be application/json."), { status: 415 });
      }
    }
    const visitor = readSession(req, res);

    if (req.method === "GET" && pathname === "/api/bootstrap") {
      return json(res, 200, {
        cities: CITIES,
        interests: INTERESTS,
        guest: !visitor.linkedin_sub,
        displayName: visitor.display_name,
        myCommunities: db
          .prepare(
            `SELECT c.id, c.name, c.city FROM memberships m
             JOIN communities c ON c.id = m.community_id
             WHERE m.visitor_id = ? ORDER BY c.name`,
          )
          .all(visitor.id),
        linkedinEnabled: Boolean(
          env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI,
        ),
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/guest") {
      await readJson(req);
      revokeCurrentSession(req);
      const guest = createVisitor();
      createSession(guest.id, res);
      return json(res, 200, { guest: true });
    }

    if (req.method === "GET" && pathname === "/api/discover") {
      const city = (url.searchParams.get("city") || CITIES[0]).trim();
      if (!city || city.length > 60) {
        throw Object.assign(new Error("Enter a city or town of up to 60 characters."), { status: 400 });
      }
      const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
      const interest = (url.searchParams.get("interest") || "").trim();
      if (interest.length > 30) {
        throw Object.assign(new Error("Interest filters must be 30 characters or fewer."), { status: 400 });
      }
      const term = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      const communities = db
        .prepare(
          `SELECT c.id, c.name, c.description, c.city, c.interests, c.activities,
                  organizer.display_name AS organizer,
                  EXISTS(SELECT 1 FROM memberships m
                         WHERE m.community_id = c.id AND m.visitor_id = ?) AS joined,
                  (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id) AS member_count
           FROM communities c JOIN visitors organizer ON organizer.id = c.organizer_id
           WHERE c.city = ? AND (c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')
             AND (? = '' OR EXISTS(
               SELECT 1 FROM json_each(c.interests) AS topic WHERE topic.value = ?
             ))
           ORDER BY c.created_at DESC LIMIT 100`,
        )
        .all(visitor.id, city, term, term, interest, interest)
        .map(mapCommunity);
      const events = db
        .prepare(
          `SELECT e.id, e.name, e.description, e.venue, e.starts_at AS startsAt,
                  c.id AS community_id, c.name AS community_name, c.city,
                  (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS attendee_count,
                  EXISTS(SELECT 1 FROM rsvps r
                         WHERE r.event_id = e.id AND r.visitor_id = ?) AS attending
           FROM events e JOIN communities c ON c.id = e.community_id
           WHERE c.city = ? AND e.starts_at >= ?
             AND (e.name LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\'
                  OR e.venue LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')
             AND (? = '' OR EXISTS(
               SELECT 1 FROM json_each(c.interests) AS topic WHERE topic.value = ?
             ))
           ORDER BY e.starts_at ASC LIMIT 100`,
        )
        .all(visitor.id, city, new Date().toISOString(), term, term, term, term, interest, interest)
        .map(mapEvent);
      const availableInterests = [
        ...new Set(
          db.prepare("SELECT interests FROM communities WHERE city = ?")
            .all(city)
            .flatMap((row) => JSON.parse(row.interests)),
        ),
      ].sort((a, b) => a.localeCompare(b));
      const communityCount = db
        .prepare("SELECT COUNT(*) AS count FROM communities WHERE city = ?")
        .get(city).count;
      const eventCount = db
        .prepare(
          `SELECT COUNT(*) AS count FROM events e JOIN communities c ON c.id = e.community_id
           WHERE c.city = ? AND e.starts_at >= ?`,
        )
        .get(city, new Date().toISOString()).count;
      return json(res, 200, { communities, events, communityCount, eventCount, availableInterests });
    }

    const communityMatch = pathname.match(/^\/api\/communities\/([0-9a-f-]+)$/i);
    if (req.method === "GET" && communityMatch) {
      const community = findCommunity(communityMatch[1], visitor.id);
      if (!community) return json(res, 404, { error: "Community not found." });
      const upcomingEvents = db
        .prepare(
          `SELECT e.id, e.name, e.description, e.venue, e.starts_at AS startsAt,
                  c.id AS community_id, c.name AS community_name, c.city,
                  (SELECT COUNT(*) FROM rsvps r WHERE r.event_id = e.id) AS attendee_count,
                  EXISTS(SELECT 1 FROM rsvps r
                         WHERE r.event_id = e.id AND r.visitor_id = ?) AS attending
           FROM events e JOIN communities c ON c.id = e.community_id
           WHERE e.community_id = ? AND e.starts_at >= ? ORDER BY e.starts_at ASC LIMIT 20`,
        )
        .all(visitor.id, community.id, new Date().toISOString())
        .map(mapEvent);
      return json(res, 200, { community: mapCommunity(community), events: upcomingEvents });
    }

    if (req.method === "POST" && pathname === "/api/communities") {
      const body = await readJson(req);
      const name = requireText(body.name, "Name", 70);
      const description = requireText(body.description, "Description", 500);
      const city = requireText(body.city, "City", 60);
      if (!Array.isArray(body.interests) || body.interests.length < 1 || body.interests.length > 5) {
        throw Object.assign(new Error("Choose between 1 and 5 interests."), { status: 400 });
      }
      const interests = [
        ...new Set(body.interests.map((value) => requireText(value, "Interest", 30))),
      ];
      const activities = Array.isArray(body.activities)
        ? body.activities.slice(0, 8).map((value) => requireText(value, "Activity", 60))
        : [];
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO communities
         (id, name, description, city, interests, activities, organizer_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, name, description, city, JSON.stringify(interests), JSON.stringify(activities), visitor.id, now);
      db.prepare(
        "INSERT INTO memberships (community_id, visitor_id, joined_at) VALUES (?, ?, ?)",
      ).run(id, visitor.id, now);
      return json(res, 201, { community: mapCommunity(findCommunity(id, visitor.id)) });
    }

    const membershipMatch = pathname.match(/^\/api\/communities\/([0-9a-f-]+)\/membership$/i);
    if (membershipMatch && req.method === "POST") {
      const community = findCommunity(membershipMatch[1], visitor.id);
      if (!community) return json(res, 404, { error: "Community not found." });
      db.prepare(
        "INSERT OR IGNORE INTO memberships (community_id, visitor_id, joined_at) VALUES (?, ?, ?)",
      ).run(community.id, visitor.id, new Date().toISOString());
      return json(res, 200, { community: mapCommunity(findCommunity(community.id, visitor.id)) });
    }
    if (membershipMatch && req.method === "DELETE") {
      db.prepare("DELETE FROM memberships WHERE community_id = ? AND visitor_id = ?")
        .run(membershipMatch[1], visitor.id);
      return json(res, 200, { joined: false });
    }

    if (req.method === "POST" && pathname === "/api/events") {
      const body = await readJson(req);
      const communityId = requireText(body.communityId, "Community", 50);
      const community = findCommunity(communityId, visitor.id);
      if (!community) return json(res, 404, { error: "Community not found." });
      if (!community.joined) {
        throw Object.assign(new Error("Join the community before organizing a gathering."), { status: 403 });
      }
      const name = requireText(body.name, "Event name", 90);
      const description = requireText(body.description, "Description", 500);
      const venue = requireText(body.venue, "Venue", 140);
      const startsAt = new Date(body.startsAt);
      if (!body.startsAt || Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
        throw Object.assign(new Error("Choose a date and time in the future."), { status: 400 });
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO events
         (id, community_id, name, description, venue, starts_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, communityId, name, description, venue, startsAt.toISOString(), visitor.id, now);
      return json(res, 201, { event: mapEvent(findEvent(id, visitor.id)) });
    }

    const eventMatch = pathname.match(/^\/api\/events\/([0-9a-f-]+)$/i);
    if (eventMatch && req.method === "GET") {
      const event = findEvent(eventMatch[1], visitor.id);
      if (!event) return json(res, 404, { error: "Gathering not found." });
      const attendees = db
        .prepare("SELECT display_name AS displayName FROM rsvps WHERE event_id = ? ORDER BY created_at ASC")
        .all(eventMatch[1]);
      return json(res, 200, { event: mapEvent(event), attendees });
    }
    const rsvpMatch = pathname.match(/^\/api\/events\/([0-9a-f-]+)\/rsvp$/i);
    if (rsvpMatch && req.method === "POST") {
      const event = findEvent(rsvpMatch[1], visitor.id);
      if (!event) return json(res, 404, { error: "Gathering not found." });
      if (new Date(event.startsAt).getTime() <= Date.now()) {
        throw Object.assign(new Error("This gathering has already started."), { status: 400 });
      }
      const body = await readJson(req);
      const displayName = requireText(body.displayName, "Name", 60);
      db.prepare(
        `INSERT INTO rsvps (event_id, visitor_id, display_name, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id, visitor_id) DO UPDATE SET display_name = excluded.display_name`,
      ).run(rsvpMatch[1], visitor.id, displayName, new Date().toISOString());
      return json(res, 200, { event: mapEvent(findEvent(rsvpMatch[1], visitor.id)) });
    }
    if (rsvpMatch && req.method === "DELETE") {
      db.prepare("DELETE FROM rsvps WHERE event_id = ? AND visitor_id = ?")
        .run(rsvpMatch[1], visitor.id);
      const event = findEvent(rsvpMatch[1], visitor.id);
      if (!event) return json(res, 404, { error: "Gathering not found." });
      return json(res, 200, { event: mapEvent(event) });
    }

    return json(res, 404, { error: "That route does not exist." });
  }

  function handleLinkedIn(req, res, url) {
    const configured =
      env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI;
    if (!configured) {
      return json(res, 501, {
        error: "LinkedIn sign-in needs LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and LINKEDIN_REDIRECT_URI.",
      });
    }

    if (url.pathname === "/api/auth/linkedin" && req.method === "GET") {
      const state = crypto.randomBytes(24).toString("base64url");
      const secure = env.NODE_ENV === "production" ? "; Secure" : "";
      res.setHeader(
        "Set-Cookie",
        `goodfolk_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/api/auth/linkedin/callback; Max-Age=600${secure}`,
      );
      const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
      authUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: env.LINKEDIN_CLIENT_ID,
        redirect_uri: env.LINKEDIN_REDIRECT_URI,
        state,
        scope: "openid profile",
      });
      res.writeHead(302, { Location: authUrl.toString(), "Cache-Control": "no-store" });
      return res.end();
    }

    if (url.pathname === "/api/auth/linkedin/callback" && req.method === "GET") {
      return completeLinkedIn(req, res, url);
    }
    return false;
  }

  async function completeLinkedIn(req, res, url) {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split(";").map((part) => {
        const [key, ...value] = part.trim().split("=");
        return [key, value.join("=")];
      }),
    );
    const stateCookie = cookies.goodfolk_oauth_state;
    const state = url.searchParams.get("state");
    if (!stateCookie || !state || stateCookie !== state || url.searchParams.get("error")) {
      return json(res, 400, { error: "LinkedIn sign-in could not be verified. Please try again." });
    }
    const clearState = `goodfolk_oauth_state=; HttpOnly; SameSite=Lax; Path=/api/auth/linkedin/callback; Max-Age=0${env.NODE_ENV === "production" ? "; Secure" : ""}`;
    appendSetCookie(res, clearState);
    const code = url.searchParams.get("code");
    if (!code) return json(res, 400, { error: "LinkedIn did not return an authorization code." });
    try {
      const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: env.LINKEDIN_REDIRECT_URI,
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        }),
      });
      if (!tokenResponse.ok) throw new Error("LinkedIn token exchange failed.");
      const tokenData = await tokenResponse.json();
      const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (!profileResponse.ok) throw new Error("LinkedIn profile request failed.");
      const profile = await profileResponse.json();
      if (typeof profile.sub !== "string" || !profile.sub) {
        throw new Error("LinkedIn did not provide a verified profile identifier.");
      }
      const displayName = [profile.given_name, profile.family_name].filter(Boolean).join(" ").slice(0, 60);
      let visitor = db
        .prepare("SELECT id FROM visitors WHERE linkedin_sub = ?")
        .get(profile.sub);
      if (visitor) {
        db.prepare("UPDATE visitors SET display_name = ? WHERE id = ?").run(displayName || null, visitor.id);
      } else {
        visitor = createVisitor(displayName || null, profile.sub);
      }
      revokeCurrentSession(req);
      createSession(visitor.id, res);
      res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
      return res.end();
    } catch (error) {
      console.error("LinkedIn authentication failed:", error.message);
      return json(res, 502, {
        error: "LinkedIn sign-in could not be completed. Check the OAuth app setup and try again.",
      });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname.startsWith("/api/auth/linkedin")) {
          const result = handleLinkedIn(req, res, url);
          if (result !== false) {
            if (result && typeof result.then === "function") await result;
            return;
          }
        }
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return json(res, 405, { error: "Method not allowed." });
      }
      const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      const filePath = path.resolve(publicDir, requestedPath);
      if (filePath !== publicDir && !filePath.startsWith(`${path.resolve(publicDir)}${path.sep}`)) {
        return json(res, 403, { error: "Forbidden." });
      }
      let content;
      try {
        content = await fs.promises.readFile(filePath);
      } catch {
        return json(res, 404, { error: "Page not found." });
      }
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'",
      });
      if (req.method === "HEAD") return res.end();
      return res.end(content);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error("Request failed:", error);
      if (!res.headersSent) {
        json(res, status, {
          error: status >= 500 ? "Something went wrong. Please try again." : error.message,
        });
      } else {
        res.end();
      }
    }
  });
  server.database = db;
  return server;
}

if (require.main === module) {
  const server = createServer();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`Goodfolk is ready at http://localhost:${port}`);
  });
}

module.exports = { createServer, CITIES, INTERESTS };
