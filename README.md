# Hermes Office 3D

A self-hosted 3D office visualization for a file-based Hermes agent swarm. It includes a Three.js frontend, a Python HTTP/API server, real-time agent status, task dispatch, and an optional meeting mode that seats meeting participants in the boardroom.

## Requirements

- Python 3.10+
- Node.js (only for optional browser/probe tests)
- A Hermes swarm vault with the folder structure expected by `office_server.py`

## Run

From the repository root:

```bash
python3 _tools/office_server.py --vault /path/to/company --host 0.0.0.0 --port 3000
```

Then open `http://localhost:3000`. Keep the server on a trusted network: the task-dispatch and meeting endpoints do not provide authentication.

The server reads agent folders and statuses from the vault. The default vault is `/opt/data/company`; use `--vault` for another location. The frontend and vendored Three.js assets are served by the same process.

## Meeting mode

Start a meeting through the API:

```bash
curl -X POST http://localhost:3000/api/meeting/start \
  -H 'Content-Type: application/json' \
  -d '{"participants":["eng","hrd"],"topic":"Planning"}'
```

End it with:

```bash
curl -X POST http://localhost:3000/api/meeting/end \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Participants are agent IDs in the server roster. They navigate to the boardroom and return to their previous work/idle state when the meeting ends. The server also supports reading an active `board/meeting.json` from the vault.

## Health and API

- `GET /api/health`
- `GET /api/layout`
- `GET /api/agents`
- `GET /api/meeting`
- `GET /api/stream` (Server-Sent Events)
- `POST /api/task`
- `POST /api/meeting/start`
- `POST /api/meeting/end`

## Checks and probes

The `_tools/office_*` scripts are project-specific layout, collision, API, and browser checks. See each tool's `--help` for options. Browser probes use Chrome DevTools Protocol and require a local headless Chrome instance.

## Vendored dependencies

`office_ui/vendor/three.min.js` and `office_ui/vendor/OrbitControls.js` are vendored Three.js project assets. Their license/copyright notices are present in each file header; retain those notices when redistributing.
