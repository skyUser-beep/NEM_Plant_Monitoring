# NEM Plant Monitoring — Current System Guide

This guide describes how the code in this repository currently works. It is
based on the implementation in `Nem_Backend/` and `Nem_Frontend/`, not on older
recovery snapshots. For installation prerequisites and the full environment
variable reference, see [README.md](./README.md).

## 1. What the program does

NEM Plant Monitoring is a browser dashboard backed by a Python FastAPI
application and PostgreSQL. It tracks assets, variables, readings, machine
cycle counts, machine running time, monitoring rules, alerts, and selected
events.

Readings can be submitted through the HTTP API or received from configured OPC
UA subscriptions. The React frontend reads API data and renders it; it does
not calculate PLC cycle counts itself and does not reload the whole page to
refresh live values.

The application contains no PLC write or machine-control endpoint. It is a
monitoring application, not a safety system.

## 2. Main parts and their responsibilities

```text
Siemens PLC / other reading producer
                 |
        OPC UA subscription or HTTP API
                 |
                 v
       FastAPI backend (Nem_Backend/app)
         |          |             |
    validation   monitoring    OPC UA collector
         |          |             |
         +----------+-------------+
                    |
                    v
               PostgreSQL
                    |
              /api/v1 responses
                    |
                    v
       React dashboard (Nem_Frontend)
```

- **FastAPI** exposes API routes, validates input, creates or updates records,
  and serves the built dashboard from `/ui/` when `Nem_Frontend/dist/` exists.
- **PostgreSQL** is the supported application database. SQLAlchemy models
  describe assets, variables, readings, machine state, rules, alerts, and
  events.
- **The OPC UA collector** subscribes to configured NodeIds, accepts good
  quality notifications, stores readings, and updates machine state.
- **The monitoring engine** evaluates rules in response to readings and
  cycle-count updates and manages rule states, alert episodes, and audit events.
- **React + Vite** provides the browser UI. Its API client uses `/api/v1` by
  default; Vite proxies `/api` to the backend during development.

### Source layout

```text
Nem_Backend/
  app/api/routes/       HTTP API routes
  app/core/             settings and environment configuration
  app/db/               SQLAlchemy base, session, UTC type, initialization
  app/models/           SQLAlchemy database models
  app/schemas/          request and response validation
  app/services/         collector, OPC UA client, monitoring, ingestion, backup
  tests/                backend tests

Nem_Frontend/
  src/app/              React entry point and route table
  src/components/common/ shared layout and UI components
  src/features/         assets, dashboard, PLC, rules, configuration, settings
  src/services/         frontend API client
  src/styles/           global styles
  src/utils/            shared formatting and frontend configuration
  scripts/              optional developer scripts
```

## 3. Backend startup and request flow

Run the backend from `Nem_Backend/`:

```powershell
python -m uvicorn app.main:app --reload
```

At application startup, `app.main`:

1. Loads and validates settings from `.env`.
2. Creates the PostgreSQL engine and SQLAlchemy session factory.
3. Runs database initialization. Missing model tables are created; the
   initialization code also adds `nem_monitoring_rules.is_archived` to an
   existing rule table if that column is absent.
4. Starts the OPC UA collector if machine mappings are configured.
5. On shutdown, stops the collector and disposes of the database engine.

Requests to `/api/v1/...` are routed to the API modules under
`Nem_Backend/app/api/routes/`. `/api/v1/ready` checks database connectivity;
`/api/v1/health` is a lightweight API health response.

At `/`, the backend redirects to `/ui/` when the frontend production build
exists. Otherwise it redirects to `/docs`, the interactive API documentation.
The frontend uses a `/ui` router base path.

## 4. OPC UA readings and machine state

### Mapping and validation

`OPCUA_MACHINE_MAPPINGS` is JSON configuration in the backend environment. It
maps one or more NodeIds to database assets and variables. A mapping may define:

- `cycle_signal`: a Boolean signal used to count cycles.
- `running_signal`: a Boolean signal used to measure running time.
- `readings`: other variables to store as readings.
- Optional `cycle_limit` and `runtime_limit_seconds` values for status display.

Before subscribing, the collector checks that mapped assets and variables
exist, are active, and belong together. Cycle and running signals must map to
Boolean variables. Duplicate assets or NodeIds in the mapping are rejected.
Mappings are configured in `.env`; they are not created automatically by the
frontend.

### Notification processing

For each notification, the collector:

1. Ignores notifications with missing or bad OPC UA quality.
2. Chooses the source timestamp, or the server timestamp if the source
   timestamp is absent. If both are absent, it uses backend receipt time.
3. Converts aware timestamps to UTC. Naive OPC UA timestamps are explicitly
   interpreted as UTC and logged.
4. Ignores non-Boolean values for cycle and running signals.
5. Checks the cycle or running signal's prior timestamp. An older notification
   is logged and rejected; the out-of-order guard remains enabled.
6. Writes the reading and applicable machine-state changes in a database
   transaction.

Ordinary reading mappings are stored as readings but do not use the cycle or
running signal timestamp guard.

### Cycle counting

The backend counts a cycle only when the cycle signal changes from `false` to
`true`. The first valid value establishes the initial state; repeated `true`
values do not count as additional cycles. A `true` to `false` change resets
the signal so the next rising edge can be counted.

The count is persisted in `machine_monitoring_states.cycle_count`. The frontend
displays this value and does not increment it.

### Running-time accumulation

A separate running signal must remain `true` while the machine is running and
become `false` when it stops. The backend accumulates elapsed time between
runtime checkpoints while the collector is connected. If it disconnects, it
accounts for elapsed time up to disconnect and clears the checkpoint; time
while disconnected is not inferred. A cycle pulse alone is not enough to
measure continuous running time.

The transition from running to stopped creates a `machine_stopped` event.
Runtime checkpoints update running-time state, not the cycle signal timestamp.

### Single collector ownership

Multiple backend processes may serve the API, but the PostgreSQL
`scheduler_leases` table is used to ensure only one process owns the OPC UA
subscription collector lease at a time. A process without the lease reports
standby and retries; it does not force the current owner out. The lease is
renewed while the collector is active and released on shutdown or failure.

## 5. Timestamps and persistence

Application timestamps are handled as UTC:

- Python code creates aware timestamps with `datetime.now(timezone.utc)`.
- `UTCDateTime` converts aware values to UTC before storing them as naive UTC
  wall-time in PostgreSQL `timestamp without time zone` columns.
- On reads, `UTCDateTime` attaches UTC to stored naive values, so application
  code receives aware UTC datetimes.
- OPC UA naive timestamps follow the documented policy above: they are treated
  as UTC, not as the server's local timezone.

Do not assume that every historical naive database value is valid UTC. Older
code or database session-timezone behavior may have shifted some stored values.
Investigate and repair only confirmed rows, within a transaction and with a
backup; do not apply a blanket timezone offset.

Key persistent records include:

- `assets`, `variables`: equipment hierarchy and monitored variable metadata.
- `nem_readings`: individual timestamped values.
- `machine_monitoring_states`: cycle count, signal states, running-time
  accumulator, and signal/checkpoint timestamps.
- `nem_monitoring_rules`, `nem_rule_states`: rule definitions and current
  evaluation state.
- `nem_alerts`: active or resolved warning/alert episodes and acknowledgements.
- `nem_monitoring_events`: audit and monitoring event history.
- `scheduler_leases`: ownership of the OPC UA collector lease.

`Base.metadata.create_all()` creates missing tables; it is not a general
database migration system. Back up production data before schema changes.

## 6. Rules, alerts, and events

Rules are stored in `nem_monitoring_rules`; their current status is stored
separately in `nem_rule_states`. Supported rule behavior is defined by the
backend validation and monitoring engine, including numeric parameter
thresholds and Boolean cycle-count thresholds. Rules may be enabled,
deactivated, or archived.

- When a rule condition is met, the engine creates or updates an active alert
  episode and records a warning/alert event.
- The database prevents duplicate active alert episodes for the same rule and
  asset.
- Acknowledging an alert records who acknowledged it and when; acknowledgement
  does not itself resolve the condition.
- Deactivating a rule resolves its active alert and removes it from active
  evaluation.
- Archiving is a soft deletion. It hides the rule from normal lists and
  evaluation while retaining history. Enabled rules must be deactivated before
  they can be archived.

The **asset Event log** is intentionally filtered to these event types:

- Rule created.
- Warning or alert triggered.
- Machine stopped.

The database may contain additional monitoring/audit event types; the asset
Event log does not display every internal event.

## 6.1 Maintenance management

Asset Detail displays maintenance history for the selected asset. Users can
create and edit jobs, view their details, and start, complete, or cancel them.
Planned and actual start/end timestamps are separate; changing the plan does
not change recorded actual times. Completing a job stores an actual completion
time, while cancellation retains the record as history.

Maintenance records remain in `nem_maintenance_records`; recurring plans are
stored separately in `nem_maintenance_schedules`. A schedule has one current
occurrence at a time. Completing it proposes the next date from the original
first-due-date anchor and recurrence rule. The proposal does not create an
occurrence until the user confirms or changes the date. Declining retains the
completed record and ends that recurrence. Confirmation is idempotent, and a
unique schedule/date key prevents duplicate occurrences.

Schedule progress is displayed as `elapsed days / total days`, counting both
the current period's start date and its due date. The first period starts on
the configured schedule start date; after approving a recurring occurrence,
the next period starts the day after the previous due date. The displayed
elapsed count can exceed the total while maintenance is overdue.

The due state is calculated server-side from the persisted due date: before it
is upcoming, on that UTC calendar date it is due today, and after it is
overdue. A leased backend task evaluates due schedules every minute and writes
one warning alert per schedule/due date to the existing `nem_alerts` table;
completion resolves that alert. The due date and alert de-duplication marker
persist across backend restarts. The evaluator is controlled by
`MAINTENANCE_DUE_ALERTS_ENABLED` (default `true`) and shares the existing
database lease table, so only one process evaluates due alerts at a time.
Legacy rows remain and are mapped to completed inspections without deletion.
Upcoming, due-today, overdue, in-progress, and completed counts appear in
Asset Detail. Recurrence supports calendar days, weeks, months, and years,
including end-of-month and leap-year dates.
Completed occurrences cannot be edited. Their Delete action archives rather
than deletes them: archived records remain in the database and are shown in a
separate archived maintenance log, with an audit event retained.
Running-hour and production-cycle maintenance scheduling is not implemented,
and PLC counters and runtime totals are unchanged.

### Evaluation timing caveat

The monitoring engine is invoked when readings are ingested and when a cycle
count changes. The API also exposes a manual monitoring-evaluation route.
Configuration fields for scheduler enablement and evaluation interval exist,
but the current application startup does not wire a periodic monitoring
evaluation task. Do not rely on those settings as evidence that a timer is
currently evaluating rules in the background.

## 7. Frontend behavior and refresh rates

The React route table is in `Nem_Frontend/src/app/App.jsx`. Main pages include
Overview, Assets, asset detail, PLC / OPC UA, Rules, Configuration, and
Settings.

The frontend updates component state from API responses; it does not reload the
document for routine updates. Current live refresh behavior is:

| Page or data | Current behavior |
| --- | --- |
| Shared layout assets/rules/alerts | Loaded on initial page setup and refreshed after explicit actions; no global interval. |
| Overview live machine/rule status | Requests PLC status and monitoring states on a recursive 500 ms timeout after each completed request. |
| Overview summary tiles | Loaded once when the Overview page opens. |
| PLC / OPC UA status | Refreshed on a recursive timeout targeting 1.5 seconds, without overlapping the same status request. |
| Asset live readings | Refreshed on a recursive 500 ms timeout while the asset page is open. |
| Asset machine/rule status | Refreshed on a recursive 1.5 second timeout while the asset page is open. |
| Asset Event log | Loaded when the Event log tab is selected. |

Timers are cleared when the relevant page/component unmounts. Form contents are
React state and are not reset by a full-page reload because routine polling
updates data in place.

## 8. Local development

Prerequisites: Python, Node.js, and a running PostgreSQL instance. Configure
`Nem_Backend/.env` with a valid `DATABASE_URL` before starting the backend.
Keep credentials out of source control.

Start the backend in one PowerShell window:

```powershell
Set-Location Nem_Backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Start the frontend in a second window:

```powershell
Set-Location Nem_Frontend
npm ci
npm run dev
```

Useful local URLs:

- Frontend: `http://127.0.0.1:5173/ui/`
- Backend API docs: `http://127.0.0.1:8000/docs`
- Backend readiness: `http://127.0.0.1:8000/api/v1/ready`
- PLC monitoring status: `http://127.0.0.1:8000/api/v1/plc/status`

For a production-style local frontend build:

```powershell
Set-Location Nem_Frontend
npm run build
```

Then start FastAPI; it serves the generated `Nem_Frontend/dist/` under `/ui/`.

## 9. OPC UA implementation and security status

The collector path issues subscription/read operations and contains no
write-to-PLC operation. OPC UA transport encryption and certificate validation
are intentionally disabled for development testing. Use this configuration only
on a trusted, isolated network. Implement the PLC-approved security policy and
certificate validation before deploying to production or an untrusted network.

## 10. Known operational limitations

- The API currently has no authentication/authorization. Do not expose it
  directly to the public internet or an untrusted network.
- The application is for monitoring only; it is not a safety interlock.
- OPC UA traffic is not encrypted during development testing; do not use this
  configuration on production or untrusted networks.
- Periodic rule-scheduler settings are present but no periodic evaluator is
  currently started by the application.
- Runtime is not extrapolated while the collector is disconnected.
- A short OPC UA publishing interval does not guarantee detection of every
  short PLC pulse; the server can revise requested settings and sampling/
  publishing behavior depends on the server.
- Backend database tests require a dedicated `TEST_DATABASE_URL`; never point
  tests at the production/application database.

## 11. Verification commands

Frontend production build:

```powershell
Set-Location Nem_Frontend
npm run build
```

Backend tests, only after configuring an isolated test database:

```powershell
Set-Location Nem_Backend
.\.venv\Scripts\python.exe -m pytest -q
```

See [README.md](./README.md) for the API catalogue, detailed environment
settings, mapping shape, timestamp repair cautions, and additional diagnostics.
