# NEM Plant Monitoring

For a code-based walkthrough of the current runtime, data flow, live refresh
behavior, and implementation limitations, see [CURRENT_SYSTEM_GUIDE.md](./CURRENT_SYSTEM_GUIDE.md).

FastAPI + PostgreSQL backend and React dashboard for monitoring industrial
assets. Readings arrive from the REST API or from a **read-only** OPC UA
subscription to a Siemens S7-1200 PLC. The backend counts machine cycles,
accumulates running time, evaluates monitoring rules, raises warnings/alerts,
and records events. The React dashboard shows this live without page reloads.

There is **no PLC write or control path**. This is monitoring software, not a
safety interlock; see [Safety](#safety).

## Project layout

```text
Nem_Backend/   FastAPI app (app/), tests (tests/), seed.py, requirements.txt, .env
Nem_Frontend/  React + Vite dashboard (built output in dist/, served at /ui/)
README.md
```

Backend layout: `app/api/routes/` (REST endpoints), `app/schemas/` (Pydantic),
`app/models/` (SQLAlchemy 2.x), `app/services/` (monitoring engine, OPC UA
client and collector, ingestion), `app/core/` (settings), `app/db/` (engine,
UTC type, startup initialization).

## How it works

1. **Collector** (`opcua_collector.py`) subscribes only to the NodeIds listed in
   `OPCUA_MACHINE_MAPPINGS` and receives data-change notifications.
2. Each notification is normalized to timezone-aware UTC, checked against the
   out-of-order guard, saved as a reading, and applied to the machine state.
3. **Cycle counting:** a cycle is counted only on a `false` â†’ `true` transition
   of the mapped *cycle signal*. The first valid value is only a baseline;
   repeated values do not count. The count is persisted in
   `machine_monitoring_states.cycle_count` and survives restarts. The frontend
   never increments counts; the backend is the single source of truth.
4. **Running time:** accumulated from a mapped *running signal* that stays `true`
   while the machine runs and `false` when stopped. A momentary cycle pulse
   cannot measure running time. Time while the collector is disconnected is not
   inferred.
5. **Rules** are evaluated when readings arrive and when a cycle is counted.
   A manual monitoring-evaluation endpoint is also available. The configured
   scheduler enablement/interval settings are not currently wired to a periodic
   evaluator. Warnings/alerts create deduplicated alert episodes.
6. The dashboard polls the status endpoints and updates React state in place.

Only one backend instance may run the collector for a database; it is guarded
by a PostgreSQL lease (see [Leases](#leases)).

## Setup (Windows PowerShell)

Prerequisites: Python 3.12+, Node.js, PostgreSQL.

Keep your existing `.env`; do not overwrite it. Back up the database before the
first startup against a new database or after upgrading.

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Frontend (separate window):

```powershell
cd C:\Users\Sahil\Downloads\NEM_Plant_Monitoring\Nem_Frontend
npm ci
npm run dev
```

- Dev dashboard: `http://127.0.0.1:5173/ui/` (Vite proxies `/api` to
  `http://127.0.0.1:8000`).
- Production-style: run `npm run build`, then FastAPI serves the built
  dashboard at `http://127.0.0.1:8000/` (redirects to `/ui/`).
- API: `http://127.0.0.1:8000`; Swagger UI `/docs`; OpenAPI `/openapi.json`.
- Restart the backend after changing `.env`, especially
  `OPCUA_MACHINE_MAPPINGS`. Press Ctrl+C to stop it.

## Database

PostgreSQL is the only supported database (`psycopg`). The NEM ORM uses
`assets`, `variables`, `machine_monitoring_states`, and `nem_*` tables
(`nem_readings`, `nem_monitoring_rules`, `nem_rule_states`, `nem_alerts`,
`nem_monitoring_events`, `nem_maintenance_records`,
`nem_maintenance_schedules`) plus `scheduler_leases` and dashboard configuration
tables. Pre-existing PLC-shaped tables
(`readings`, `monitoring_rules`, `alerts`, and others) are left untouched.

At startup `Base.metadata.create_all()` creates missing tables. Additive startup
updates also add `nem_monitoring_rules.is_archived`, maintenance schedule links,
the maintenance period-start date (backfilled from each schedule's start date),
and fields required to use the existing alerts table for due-date alerts. Older
maintenance rows are retained and treated as completed inspections;
`actual_completed_at` is backfilled from their legacy `performed_at` value. No
rows are deleted. Back up production data before deploying schema changes.

### Timestamp convention

- Python: timezone-aware **UTC** everywhere.
- PostgreSQL: columns are `timestamp without time zone` holding **UTC wall time**.
  The `UTCDateTime` type (`app/db/session.py`) converts aware datetimes to UTC
  on write and marks them UTC on read.
- Naive incoming OPC UA timestamps are interpreted as UTC and logged. Missing
  timestamps use the backend's current UTC time.
- Older code could store UTC values shifted by the PostgreSQL session timezone
  (for example `Asia/Calcutta`, +5:30), producing "future" timestamps that made
  valid notifications look out of order. Current code stores UTC correctly.
  Legacy shifted rows must be repaired deliberately; never apply a blind
  offset. Compare suspect rows against `now() AT TIME ZONE 'UTC'`, restrict
  changes to confirmed rows, work inside a transaction with `RETURNING`, and
  confirm counts before `COMMIT`.

### Out-of-order guard

The collector rejects a notification older than the last accepted cycle/running
signal timestamp and logs a warning with both timestamps. The guard is kept; fix
inconsistent timestamps at the source rather than disabling it.

## Environment configuration (`Nem_Backend/.env`)

No secrets belong in source control.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `postgresql+psycopg://user:<URL-encoded-password>@localhost:5432/plc_monitoring`. No fallback. |
| `TEST_DATABASE_URL` | Dedicated test database, different from the application database. |
| `CORS_ORIGINS` | Comma-separated browser origins; empty (disabled) by default. |
| `MONITORING_SCHEDULER_ENABLED` | Declared configuration setting; periodic evaluation is not currently started by the application. |
| `MONITORING_EVALUATION_INTERVAL_SECONDS` | Declared scheduler interval setting; no periodic evaluator currently consumes it. |
| `MAINTENANCE_DUE_ALERTS_ENABLED` | Enables the leased maintenance due-alert evaluator; defaults to `true` and checks once per minute. |
| `MONITORING_DEFAULT_STALE_AFTER_SECONDS` | Freshness window, default `300`; a rule may override it. |
| `OPCUA_ENDPOINT` | `opc.tcp://host:port/...` for the PLC. |
| `OPCUA_USERNAME`, `OPCUA_PASSWORD` | Optional; set both or neither. |
| `OPCUA_TIMEOUT_SECONDS` | Connection/read timeout, default `10`. |
| `OPCUA_RECONNECT_DELAY_SECONDS` | Delay before reconnecting, default `5`. |
| `OPCUA_SUBSCRIPTION_PUBLISHING_INTERVAL_MS` | Requested publishing interval, default `1000`. The server may revise it; `/api/v1/plc/status` reports requested and negotiated values. |
| `OPCUA_RUNTIME_CHECKPOINT_SECONDS` | Running-time checkpoint interval, default `10`. Does not set the publishing interval. |
| `OPCUA_MACHINE_MAPPINGS` | JSON array of NodeId mappings (below). Empty disables the collector. |
| `SETTINGS_ENCRYPTION_KEY` | Fernet key for the dashboard's SMTP password. |
| `BACKUP_DIRECTORY` | Backup snapshot location, default `Nem_Backend/backups`. |

The monitored-item sampling interval is asyncua's `50` ms default and the queue
size is the server default. A short publishing interval does not guarantee that
very short pulses are captured.

## OPC UA machine mappings

The collector's subscription and one-shot read paths are read-only. OPC UA
transport encryption and certificate validation are intentionally disabled for
development testing. Use this only on a trusted, isolated network; do not use
this configuration on production or untrusted networks. Add the PLC-approved
security policy and certificates before deployment.

Mappings live in `OPCUA_MACHINE_MAPPINGS`; they are not created from the UI.
There is at most one entry per asset, and a NodeId may be mapped only once
across all assets. Every `variable_id` must be an active variable that belongs
to the mapped asset, with a matching data type (Boolean for cycle/running).

```dotenv
OPCUA_MACHINE_MAPPINGS=[{"asset_id":<ASSET_ID>,"cycle_signal":{"node_id":"<CYCLE_NODEID>","variable_id":<BOOLEAN_VARIABLE_ID>},"running_signal":{"node_id":"<RUNNING_NODEID>","variable_id":<BOOLEAN_VARIABLE_ID>},"readings":[{"node_id":"<VALUE_NODEID>","variable_id":<VARIABLE_ID>}],"cycle_limit":<OPTIONAL>,"runtime_limit_seconds":<OPTIONAL>}]
```

Example of the current local setup (one asset's cycle and running signals, plus
a second asset with an ordinary reading):

```dotenv
OPCUA_MACHINE_MAPPINGS=[{"asset_id":2,"cycle_signal":{"node_id":"ns=4;i=13","variable_id":11},"running_signal":{"node_id":"ns=4;i=14","variable_id":15}},{"asset_id":3,"readings":[{"node_id":"ns=4;i=15","variable_id":12}]}]
```

To add a running signal: create a Boolean variable on the asset (with
`opcua_node_id` set), add it as `running_signal`, remove the NodeId from any
other mapping, and restart the backend. Running time stays at zero until the
mapped signal reports `true`.

`GET /api/v1/plc/status` (read-only) returns connection state, requested and
negotiated publishing interval, configured mappings (with validity), and per
machine: status, `cycle_count`, `running_seconds`, last signal time, staleness,
limits, and active alerts. Alerts listed here come only from enabled,
non-archived rules.

## Leases

A `scheduler_leases` row elects one scheduler worker and one collector owner
(`opcua-subscription-collector`). Acquisition and renewal are atomic updates; a
lease can be reclaimed once expired, and shutdown releases only the owner's own
lease. Lease duration is in seconds (default 30, capped at 900). A lease with a
far-future expiry is a symptom of the legacy timestamp shift above. If a stale
lease from a stopped backend blocks startup, verify no backend process owns it,
then correct that single row with an owner- and expiry-matched `UPDATE` (never
delete it or change the owner). Do not force-take a lease from a live owner.

## Dashboard

- **Overview:** summary tiles, a *Live cycle monitoring* panel (cycle count, last
  signal, running time, rule status, thresholds for each mapped machine), and
  active alerts with acknowledgement.
- **Assets â†’ asset page:** machine strip (status, cycles, running time, last
  signal, OPC UA connection, mapped cycle signal), *Live values* with the latest
  reading per variable, rule list, logbook, and Event log.
- **PLC / OPC UA:** connection test, one-shot read,
  mapping and publishing-interval details, and live machine cards.
- **Configuration / Settings:** rules, collections, documents, import, profile,
  SMTP, usage, and backup/restore.

Live polling (React state updates, no reloads, overlapping requests prevented,
timers cleaned up on unmount, errors shown without crashing):

| View | Data | Interval |
| --- | --- | --- |
| Overview live panel | `/plc/status`, `/monitoring/status` | 500 ms |
| PLC page | `/plc/status` | 1.5 s |
| Asset page | latest readings | 500 ms |
| Asset page | `/plc/status`, rules, rule states | 1.5 s |

Form modals keep what you typed while polling refreshes their options.

### Cycle-count threshold rules

Rule type `boolean_count_threshold` watches the persistent backend cycle count
with two increasing warning thresholds and a larger alert threshold, for
example `9000`, `9500`, and `10000`. It must target the Boolean variable
configured as the asset's `cycle_signal`; otherwise creation is rejected. In the
UI, open an asset, choose **Add rule**, select **Boolean cycle-count
thresholds**, and pick the configured cycle signal. If the dropdown is empty, the
asset has no cycle signal in `OPCUA_MACHINE_MAPPINGS`. Enabled rules are
evaluated on each accepted cycle increment.

### Rule lifecycle

- **Deactivate** a rule: its state becomes `unknown` and its active alert is
  closed (resolved) with history retained, so the asset no longer shows red.
- **Archive** (the *Archive* button appears only for deactivated rules; API
  `DELETE /api/v1/rules/{id}`): hides the rule from normal lists and
  evaluation while keeping evaluation state, alerts, and events. Archiving an
  enabled rule is rejected.
- Re-enabling a rule evaluates it again.

### Event log

The asset Event log shows only: rule created, warning/alert triggered, and
machine stopped. Cycle pulses and routine evaluation or maintenance events are
not shown. Other audit events remain in the database and are available from
`GET /api/v1/events`.

## API endpoints

Health: `GET /api/v1/health`, `GET /api/v1/ready`.

**Assets:** `POST/GET /api/v1/assets`, `GET/PATCH/DELETE /api/v1/assets/{id}`,
`GET /assets/{id}/children`, `GET /assets/{id}/hierarchy`,
`POST /assets/{id}/move`. Delete only when no dependents exist; otherwise
deactivate.

**Variables:** `POST/GET /api/v1/assets/{id}/variables`,
`GET/PATCH /api/v1/variables/{id}`. Types: `number`, `integer`, `string`,
`boolean`. Keys are unique per asset; `opcua_node_id` is unique.

**Readings:** `POST /api/v1/readings`, `POST /api/v1/readings/batch` (1â€“100,
atomic), `GET /readings/variables/{id}/latest`, `GET /readings/assets/{id}/latest`,
`GET /readings/variables/{id}` (time filters, pagination). Values must match the
variable type, the variable must belong to the asset, and readings more than five
minutes in the future are rejected. Request bodies with a declared
`Content-Length` greater than 25 MiB are rejected.

**Rules and monitoring:** `POST/GET /api/v1/rules`, `GET/PATCH /rules/{id}`,
`GET /rules/{id}/status`, `POST /monitoring/evaluate`, `GET /monitoring/status`,
`GET /assets/{id}/monitoring-status`. Rule types: `parameter_threshold`,
`runtime_duration`, `duration`, `generic`, `boolean_condition`,
`boolean_count_threshold`. Severity is `warning` or `alert`. Missing, stale,
future-dated, or invalid input is `unknown`, never normal.

**Alerts and events:** `GET /alerts/active`, `GET /alerts`,
`GET /alerts/{id}`, `POST /alerts/{id}/acknowledge`, `GET /events`,
`GET /events/{id}`. `/alerts/active` excludes alerts of disabled or archived
rules. Acknowledgement does not resolve the condition. No email or other
outbound notification is sent.

**Maintenance:** `POST /api/v1/maintenance`, `GET /api/v1/maintenance`,
`GET/PATCH/DELETE /api/v1/maintenance/{id}`, and
`POST /api/v1/maintenance/{id}/start`, `/complete`, or `/cancel`. Asset Detail
includes maintenance history, create and edit forms, status actions, planned
and actual dates, and summary counts. Completed occurrences are read-only;
DELETE archives them in a separate log without deleting their history.
Cancelling retains the record. Planned
work uses calendar dates only; running-hour and cycle-based maintenance
scheduling is not implemented. Schedules use `POST/GET
/api/v1/maintenance/schedules`, `GET/PATCH
/api/v1/maintenance/schedules/{schedule_id}`, and the
`/confirm-next` and `/decline-next` actions. Due-date alerts are active warning
rows in the existing `nem_alerts` table and are evaluated by a leased backend
task; they are resolved when the occurrence is completed. Schedule progress is
shown as elapsed/total calendar days, inclusive of the current period's start
and due dates. Deleting completed maintenance archives it from the active list
without deleting the history; the archived log and an audit event retain it.

**Dashboard summary:** `GET /api/v1/dashboard/summary` (asset counts, rule state
counts, active and unacknowledged alerts, latest reading time; archived and
disabled rules are not counted as active).

**Dashboard compatibility endpoints** (used by the React app): `/summary`,
`/assets/{id}/rules` (+ `/rules/bulk`), `DELETE /rules/{id}` (archive),
`/assets/{id}/logbook`, `/assets/{id}/events`, `/collections`, `/documents`,
`/import`, `/me`, `/settings/{section}`, `/usage`, `/backups` and
`/backups/{id}/restore`. Backup restore **replaces** current monitoring data;
keep backup files protected and confirm the prompt.

**PLC / OPC UA:** `GET /plc/status`, `GET /plc/test` (reads `i=2258`),
`POST /plc/discover` and `GET /plc/discover/{job_id}` (browse nodes),
`POST /plc/read` (one read stored as a normal reading, running matching rules).
There are no write operations.

Errors use `{"error": {"code": 404, "message": "..."}}` or FastAPI's `detail`.

Node-RED can post readings to `POST /api/v1/readings` instead of writing to the
database directly:

```json
{
  "asset_id": 8,
  "variable_id": 12,
  "value": 900,
  "recorded_at": "2026-10-12T06:30:00Z",
  "source_id": "node-red",
  "metadata": {"machine": "Machine 1", "signal": "Motor.RotationCount"}
}
```

## Verifying OPC UA operation

1. Start the backend and confirm `GET /api/v1/plc/status` shows
   `connection.connected: true`, the expected mappings, and a negotiated
   publishing interval.
2. Watch `cycle_count` rise while the cycle signal toggles. Confirm the latest
   readings alternate and `last_seen_at` is current.
3. For a running signal, confirm `status: running` and growing `running_seconds`.
4. If notifications are logged as out of order, compare stored timestamps with
   `now() AT TIME ZONE 'UTC'` for the legacy shift described above.
5. If the collector reports a lease conflict, see [Leases](#leases).

## Demo data

`python seed.py` (from `Nem_Backend`) creates an idempotent, clearly marked demo
asset tree, variables, and sample readings. It does not modify real assets, and
does not represent live equipment.

## Tests and builds

Backend tests need a dedicated PostgreSQL test database in `TEST_DATABASE_URL`
(never the application database); each test rolls back its changes:

```powershell
cd Nem_Backend
.\.venv\Scripts\python.exe -m pytest -q
```

Without `TEST_DATABASE_URL`, database-backed tests error during setup.

Frontend build check:

```powershell
cd Nem_Frontend
npm run build
```

## Safety

This software only reads PLC values. It does not stop machinery and is not a
substitute for certified PLC safety logic, operator procedures,
authentication/authorization, or industrial network hardening. The API has no
authentication yet; do not expose it to a factory network or the internet. An
alert means a configured software condition was met, not that equipment is
physically safe or unsafe.

## Limitations

Not implemented: email/SMS delivery, authentication and roles, automatic
calendar-trigger rules, maintenance task templates, and analytics integrations.
Validate the read-only OPC UA path with approved credentials and simulated
inputs before connecting live equipment.
