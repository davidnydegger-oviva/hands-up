# Hands Up

A lightweight web app that turns physical Flic buttons into a "raise hand" queue for in-person meetings.

## Setup

```bash
git clone <repo>
cd hands-up
npm install
cp .env.example .env
# Edit .env if needed
node server.js
```

Open `http://localhost:3000` in your browser.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ADMIN_PASSWORD` | *(none — must be set)* | Password for admin panel |
| `DB_PATH` | `./data/hands.db` | SQLite database path |

## Pages

- **`/`** — Landing page with status and links
- **`/display`** — Full-screen display for meeting room screen (dark theme, large text)
- **`/admin`** — Admin panel for managing meetings and button assignments

## Flic Button Configuration

For each button (1–10), configure in the Flic app:

- **Click action:** HTTP Request → `POST https://your-server.com/api/button/1/raise`
- **Double-click action:** HTTP Request → `POST https://your-server.com/api/button/1/lower`
- No headers or body needed
- Replace `1` with the button number (1–10)
- Replace `your-server.com` with your server's address

## Production Deployment

### With PM2

```bash
pm2 start server.js --name hands-up
```

### Nginx Configuration

Proxy to `localhost:3000`. Add these directives for SSE support:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection '';
    proxy_http_version 1.1;
    chunked_transfer_encoding off;
    proxy_buffering off;
    proxy_cache off;
}
```

## API Reference

### Button Endpoints (no auth, called by Flic hub)

- `POST /api/button/:buttonNumber/raise` — Raise hand
- `POST /api/button/:buttonNumber/lower` — Lower hand

### Facilitator Endpoints

- `POST /api/meetings/:meetingId/next` — Dismiss top of queue
- `POST /api/meetings/:meetingId/clear` — Clear all hands

### Admin Endpoints (require `X-Admin-Password` header)

- `GET /api/meetings` — List meetings
- `POST /api/meetings` — Create meeting `{ name }`
- `PUT /api/meetings/:id` — Update meeting
- `DELETE /api/meetings/:id` — Delete meeting
- `POST /api/meetings/:id/activate` — Set as active
- `POST /api/meetings/:id/deactivate` — Deactivate
- `GET /api/meetings/:id/assignments` — List assignments
- `PUT /api/meetings/:id/assignments` — Bulk update `[{ button_number, person_name }]`

### SSE Streams

- `GET /api/meetings/:meetingId/stream` — Stream for specific meeting
- `GET /api/active/stream` — Auto-connects to active meeting

### State

- `GET /api/meetings/:meetingId/state` — Current state as JSON
- `GET /api/active/state` — Active meeting state
