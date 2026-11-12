# Goodfolk

A community and gathering platform for finding people nearby through shared, real-world interests.

## Run locally

Requires Node.js 22.5 or later. SQLite is provided by Node's built-in `node:sqlite` module; there are no third-party runtime packages.

```powershell
npm start
```

Open [http://localhost:3000](http://localhost:3000). Set `PORT` to use another port and `DATABASE_PATH` to choose where the SQLite database is stored. The app creates its database and tables on first start. The initial city lists are empty by design: communities and gatherings are created and persisted by their organizers, rather than presented as fictional activity.

## What's working

- Browse and search communities and upcoming gatherings by city and interest.
- Continue as a guest without an account. Guest sessions use a random, HTTP-only, same-site cookie; the database stores only its hash.
- Create communities and join or leave them. Community organizers are automatically their first member.
- Create gatherings in communities you've joined, RSVP using only a display name, view attendees, or cancel an RSVP.
- Data, memberships, and RSVPs persist in SQLite across restarts.

The city list in `server.js` provides location suggestions, and any city or town can be entered directly. Organizers can also add specific, niche interests beyond the suggested list. Community organizers and event attendees supply the actual local listings.

## Optional LinkedIn sign-in

LinkedIn OAuth is optional. To enable it, register an app in the LinkedIn Developer Portal, enable OpenID Connect sign-in, and configure its exact callback URL. Set these server environment variables:

- `LINKEDIN_CLIENT_ID`
- `LINKEDIN_CLIENT_SECRET`
- `LINKEDIN_REDIRECT_URI` (for example, `https://your-domain.example/api/auth/linkedin/callback`)

Without these credentials the LinkedIn option clearly reports that setup is required, while guest access remains available. OAuth uses the authorization-code flow, validates a one-time state value, and requests only `openid profile`. For production, serve the app over HTTPS and set `NODE_ENV=production` so session cookies are marked `Secure`.

## Production notes

The app is a dependency-free single-process Node.js service using SQLite for durable local storage. For a public deployment, use persistent disk storage for `DATABASE_PATH`, HTTPS, database backups, rate limiting at the reverse proxy, and operational monitoring. For horizontally scaled deployments or high write volume, migrate SQLite to a managed relational database and share session storage before adding multiple app instances.
