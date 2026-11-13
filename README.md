# Hermes Office 3D

A self-hosted 3D office visualization for a file-based Hermes agent swarm: a Three.js frontend (no build step) and a stdlib-only Python HTTP/API server. It shows live agent status, lets you dispatch tasks and run meetings, spreads idle agents across four hangout zones, and includes a layout editor. Everything sits behind a login.

## Requirements

- Python 3.10+ (standard library only)
- Node.js 22+ and a headless Chrome, only for the optional browser probes
- A Hermes swarm vault (see [Vault conventions](#vault-conventions))

## Quick start (demo)

```bash
python3 _tools/office_server.py --demo --port 3000
```

Open `http://localhost:3000`. `--demo` creates a temporary vault with demo agents and a simulator. The simulator changes statuses, runs meetings, and hires new agents over time (a QA tester, Legal, a Finance auditor, an SRE), so you can watch the layout grow. `--demo` may run without a password **only** on a loopback host.

## Run in production

The server refuses to start without an admin password, except `--demo` on loopback.

```bash
# plain password from env (min 12 chars) ...
HERMES_OFFICE_PASSWORD='a-long-passphrase' python3 _tools/office_server.py --vault /path/to/company

# ... or a pre-computed scrypt hash (nothing secret in the process env)
python3 _tools/office_server.py --hash-password < pw.txt   # prints scrypt$...
HERMES_OFFICE_PASSWORD_HASH='scrypt$...' python3 _tools/office_server.py --vault /path/to/company

# ... or a file
python3 _tools/office_server.py --vault /path/to/company --password-file /run/secrets/office_pw
```

| Option | Env | Default |
| --- | --- | --- |
| `--port` | `OFFICE_PORT` | `3000` |
| `--host` | `OFFICE_HOST` | `127.0.0.1` |
| `--vault` | `OFFICE_VAULT` | `/opt/data/company` |
| `--webroot` | `OFFICE_WEBROOT` | `<vault>/office_ui`, else `office_ui/` in this repo |
| `--trust-proxy` | `OFFICE_TRUST_PROXY=1` | off |

### Security model

- One admin password, hashed with scrypt. Sessions live in memory: an `HttpOnly` + `SameSite=Strict` cookie, valid for 12 h, with `Secure` added behind HTTPS.
- Every `POST` needs the session's `X-CSRF-Token`, and any `Origin` it sends must match the host.
- After 5 failed logins per IP in 15 minutes, login returns `429` with `Retry-After`.
- The server sends a strict CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and HSTS (behind HTTPS), and no CORS headers.
- Only `/login` and its assets plus `/api/health` (status only) are public. Other pages redirect to `/login`, and other APIs return `401`.
- The vault is read-only, except for `swarm.py task`, `board/meeting.json` and `board/office_layout.json`. Task-file reads cannot leave an agent's folder.

TLS is not built in. Put a reverse proxy in front and pass `--trust-proxy` so the real client IP and HTTPS are detected. Caddy example:

```caddyfile
office.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

```bash
HERMES_OFFICE_PASSWORD_HASH='scrypt$...' python3 _tools/office_server.py \
  --vault /opt/data/company --host 127.0.0.1 --port 3000 --trust-proxy
```

Keep `--host 127.0.0.1` when you use a proxy, so the app is not reachable over plain HTTP.

## Vault conventions

The roster is discovered from folders. Restarts are not needed: new agents appear within a few seconds.

```
<vault>/AGENTS.md                          -> CEO (id ".")
<vault>/<dept>/AGENTS.md                   -> department manager (id "<dept>")
<vault>/<dept>/workers/<name>/AGENTS.md    -> worker (id "<dept>/workers/<name>")
```

A folder counts as an agent if it has `AGENTS.md`, `tasks/` or `memory/`. An optional `office.json` in the agent folder overrides display fields:

```json
{"name": "Rara", "role": "Contract reviewer", "color": "#14b8a6", "dept_label": "Legal"}
```

### Dynamic layout

- Known departments use their own rooms. When a department outgrows its room, or a new department appears, the server adds **annex rooms** in a row south of all rooms. An annex room holds at most 6 desks.
- The building outline is derived from the rooms: it wraps every room with a 2 m corridor, closes gaps narrower than 6 m, and picks the entrance on the longest south wall. Camera framing grows with it.
- Agents walk on an A* grid (0.25 m cells) built from the real 3D scene: walls, desks, chairs, furniture and decor are all obstacles, so agents never walk through objects.
- Every agent always gets its own desk. Seats are never shared and no room is overloaded.
- `_tools/office_layout_check.py` and `_tools/office_collision_check.py` validate both the default layout and a stress roster (17 rooms, 41 desks).

## Layout editor

Click **Edit denah** in the toolbar (or press `E`). You can:

- draw a new room by dragging on empty floor, delete rooms, give them any name, and pick a type: department, executive, meeting room, hangout, open plaza, or empty. A drawn room gets its door on the side facing the building;
- drag any room to move it, or drag the handles on its sides to resize it (0.5 m grid, 4 to 40 m per side). Furniture inside a moved room moves with it;
- set the door side, accent color, and built-in decor. Built-in decor only shows while a room is at least its original size;
- assign a department to a room (capacity overflow still goes to annex rooms);
- place and drag furniture from a catalog of 13 props, up to 120 in total. Clicking a prop opens a floating toolbar: rotate 90° left/right (`Shift+R` / `R`), any angle with the slider, duplicate (`Ctrl+D`), and delete (`Del`);
- undo with `Ctrl+Z` or **Urungkan**.

While editing, the left mouse button belongs to the editor: right-drag rotates the camera, middle-drag pans it, and the wheel zooms.

Every room change is rebuilt by the server and previewed live in 3D. An invalid change is rejected and rolled back. A change is invalid if rooms overlap, a door is blocked by another room, a room is too far from the rest of the building, or no meeting room is left. A meeting room must be at least 10.5 × 7.5 m. A prop must sit inside a single room and must not block desks, chairs, doors or other props; meeting rooms are locked. Changes are saved to `<vault>/board/office_layout.json` (version 2: the full room list). Props store a free angle in `deg`. Version 1 files, which held only labels, colors and decor, and props with the old quarter-turn `rot`, are migrated automatically. If you hand-edit that file and it becomes invalid, the default rooms are used, and invalid props are hidden; nothing crashes.

## Meeting mode

Use the **Rapat** button in the UI, or call the API with a session (see below):

```bash
curl -b jar -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{"participants":["eng","hrd"],"topic":"Planning"}' http://localhost:3000/api/meeting/start
curl -b jar -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
  -d '{}' http://localhost:3000/api/meeting/end
```

Participants walk to the boardroom (18 seats max) and return to their previous state afterwards. An existing `board/meeting.json` in the vault is also picked up.

## API

Scripted access with a cookie jar and the CSRF token:

```bash
CSRF=$(curl -s -c jar -H 'Content-Type: application/json' \
  -d '{"password":"a-long-passphrase"}' http://localhost:3000/api/login | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrf"])')
curl -s -b jar http://localhost:3000/api/agents
```

| Method | Path | |
| --- | --- | --- |
| GET | `/api/health` | liveness (counts only when logged in) |
| GET | `/api/session` | session state + CSRF token |
| GET | `/api/layout` | rooms, desks, building, meeting room, props |
| GET | `/api/agents`, `/api/agent/<id>` | live status |
| GET | `/api/task-file?agent=..&name=..` | one task file of an agent |
| GET | `/api/meeting` | active meeting |
| GET | `/api/office-layout` | editor document + prop catalog |
| GET | `/api/stream` | Server-Sent Events snapshots |
| POST | `/api/login`, `/api/logout` | |
| POST | `/api/task` | dispatch a task via `_tools/swarm.py task` |
| POST | `/api/meeting/start`, `/api/meeting/end` | |
| POST | `/api/office-layout` | `{doc, dry_run, preview}`: validate (preview also returns the built layout), then save |

## Checks and probes

```bash
python3 _tools/office_demo.py                        # simulator self-check
python3 _tools/office_layout_check.py                # default + stress layout
python3 _tools/office_collision_check.py
python3 _tools/office_api_check.py --base http://127.0.0.1:3000 [--password PW]
python3 _tools/office_meeting_check.py --base http://127.0.0.1:3000 [--password PW] [--vault PATH]

# browser probes (need: chrome --headless=new --remote-debugging-port=9222 about:blank)
node _tools/office_ui_probe.mjs --url http://127.0.0.1:3000/ --audit 120
node _tools/office_collision_probe.mjs --url http://127.0.0.1:3000/
node _tools/office_meeting_probe.mjs --url http://127.0.0.1:3000/
```

Each tool has `--help`.

## Vendored dependencies

`office_ui/vendor/three.min.js` (r128) and `office_ui/vendor/OrbitControls.js` are vendored Three.js assets. Their license notices are in each file header; keep them when redistributing.
