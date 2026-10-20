from datetime import datetime, timedelta, timezone
from pathlib import Path
import re

from tests.test_api import create_asset, create_reading, create_variable
from app.services.maintenance_schedule import (
    due_status,
    emit_due_schedule_events,
    next_due_date,
)


def test_maintenance_records_are_persisted_and_filterable(client):
    asset_id = create_asset(client)
    variable_id = create_variable(client, asset_id)
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Rotation service",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "operator": ">=",
            "threshold": 900,
            "severity": "warning",
        },
    )
    assert rule.status_code == 201, rule.text
    create_reading(client, asset_id, variable_id, 900)
    alert = client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()["items"][0]
    performed_at = datetime.now(timezone.utc)
    next_due_at = performed_at + timedelta(days=180)

    created = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "alert_id": alert["id"],
            "summary": "Motor lubrication and inspection",
            "notes": "Checked bearing temperature and added lubricant.",
            "performed_by": "Maintenance team",
            "performed_at": performed_at.isoformat(),
            "next_due_at": next_due_at.isoformat(),
        },
    )

    assert created.status_code == 201, created.text
    record = created.json()
    assert record["asset_id"] == asset_id
    assert record["alert_id"] == alert["id"]
    assert record["performed_by"] == "Maintenance team"
    assert client.get(f"/api/v1/maintenance?asset_id={asset_id}").json()["total"] == 1
    assert client.get(f"/api/v1/maintenance?alert_id={alert['id']}").json()["total"] == 1
    assert client.get(f"/api/v1/maintenance/{record['id']}").json()["summary"] == (
        "Motor lubrication and inspection"
    )
    maintenance_events = client.get(
        "/api/v1/events?event_type=maintenance_completed"
    ).json()
    assert maintenance_events["total"] == 1
    assert maintenance_events["items"][0]["metadata"]["maintenance_record_id"] == record["id"]
    assert client.get(f"/api/v1/assets/{asset_id}").status_code == 200
    assert client.delete(f"/api/v1/assets/{asset_id}").status_code == 409


def test_maintenance_rejects_unrelated_alert_and_invalid_dates(client):
    asset_id = create_asset(client)
    other_asset_id = create_asset(client, "Other asset")
    variable_id = create_variable(client, asset_id)
    rule = client.post(
        "/api/v1/rules",
        json={
            "name": "Threshold",
            "rule_type": "parameter_threshold",
            "target_asset_id": asset_id,
            "variable_id": variable_id,
            "operator": ">",
            "threshold": 1,
            "severity": "alert",
        },
    )
    assert rule.status_code == 201
    create_reading(client, asset_id, variable_id, 2)
    alert = client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()["items"][0]

    unrelated = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": other_asset_id,
            "alert_id": alert["id"],
            "summary": "Incorrect association",
            "performed_by": "Operator",
        },
    )
    assert unrelated.status_code == 422

    invalid_dates = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "summary": "Bad date range",
            "performed_by": "Operator",
            "performed_at": "2026-06-01T00:00:00",
            "next_due_at": "2026-05-01T00:00:00",
        },
    )
    assert invalid_dates.status_code == 422


def test_maintenance_job_lifecycle_is_persisted_and_asset_scoped(client):
    asset_id = create_asset(client, "Maintenance target")
    other_asset_id = create_asset(client, "Other target")
    planned_start = datetime.now(timezone.utc) + timedelta(days=2)
    planned_end = planned_start + timedelta(hours=2)
    created = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "title": "Replace motor bearings",
            "maintenance_type": "preventive",
            "status": "planned",
            "planned_start_at": planned_start.isoformat(),
            "planned_end_at": planned_end.isoformat(),
            "priority": "high",
            "assigned_technician": "Alex",
            "notes": "Inspect and replace worn bearings.",
            "parts_used": "Bearing kit",
            "checklist": [{"item": "Isolate machine", "completed": False}],
        },
    )
    assert created.status_code == 201, created.text
    record = created.json()
    assert record["status"] == "planned"
    assert record["title"] == "Replace motor bearings"
    assert record["assigned_technician"] == "Alex"
    assert record["actual_started_at"] is None
    assert client.delete(f"/api/v1/maintenance/{record['id']}").status_code == 409
    assert client.delete(
        f"/api/v1/maintenance/{record['id']}/permanent"
    ).status_code == 409
    assert client.get(
        f"/api/v1/maintenance?asset_id={asset_id}"
    ).json()["total"] == 1
    assert client.get(
        f"/api/v1/maintenance?asset_id={other_asset_id}"
    ).json()["total"] == 0

    revised_start = planned_start + timedelta(hours=1)
    revised_end = planned_end + timedelta(hours=1)
    updated = client.patch(
        f"/api/v1/maintenance/{record['id']}",
        json={
            "planned_start_at": revised_start.isoformat(),
            "planned_end_at": revised_end.isoformat(),
            "assigned_technician": "Jordan",
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["planned_start_at"] == revised_start.isoformat()
    assert updated.json()["actual_started_at"] is None

    started = client.post(f"/api/v1/maintenance/{record['id']}/start")
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "in_progress"
    actual_started_at = started.json()["actual_started_at"]
    assert actual_started_at is not None
    rescheduled_start = revised_start + timedelta(hours=3)
    rescheduled_end = revised_end + timedelta(hours=3)
    rescheduled = client.patch(
        f"/api/v1/maintenance/{record['id']}",
        json={
            "planned_start_at": rescheduled_start.isoformat(),
            "planned_end_at": rescheduled_end.isoformat(),
        },
    )
    assert rescheduled.status_code == 200, rescheduled.text
    assert rescheduled.json()["actual_started_at"] == actual_started_at

    invalid_actual_update = client.patch(
        f"/api/v1/maintenance/{record['id']}",
        json={
            "actual_completed_at": (
                datetime.fromisoformat(actual_started_at.replace("Z", "+00:00"))
                - timedelta(seconds=1)
            ).isoformat()
        },
    )
    assert invalid_actual_update.status_code == 422

    completed = client.post(f"/api/v1/maintenance/{record['id']}/complete")
    assert completed.status_code == 200, completed.text
    completed_record = completed.json()
    assert completed_record["status"] == "completed"
    assert completed_record["actual_completed_at"] is not None
    assert client.get(f"/api/v1/maintenance/{record['id']}").json()["status"] == "completed"
    completed_edit = client.patch(
        f"/api/v1/maintenance/{record['id']}",
        json={"notes": "Should not alter completed history."},
    )
    assert completed_edit.status_code == 409
    assert client.post(
        f"/api/v1/maintenance/{record['id']}/cancel"
    ).status_code == 409


def test_completed_maintenance_can_be_archived_without_deleting_history(client):
    asset_id = create_asset(client, "Maintenance archive asset")
    created = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "summary": "Completed service",
            "performed_by": "Operator",
            "performed_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    assert created.status_code == 201, created.text
    record_id = created.json()["id"]

    archived = client.delete(f"/api/v1/maintenance/{record_id}")
    assert archived.status_code == 204
    assert client.delete(f"/api/v1/maintenance/{record_id}").status_code == 204
    assert client.get(
        f"/api/v1/maintenance?asset_id={asset_id}"
    ).json()["total"] == 0

    history = client.get(
        f"/api/v1/maintenance?asset_id={asset_id}&include_archived=true"
    )
    assert history.status_code == 200
    assert history.json()["total"] == 1
    assert history.json()["items"][0]["id"] == record_id
    assert history.json()["items"][0]["archived_at"] is not None
    assert client.get(f"/api/v1/maintenance/{record_id}").json()["id"] == record_id
    events = client.get(
        f"/api/v1/events?asset_id={asset_id}&event_type=maintenance_record_archived"
    )
    assert events.status_code == 200
    assert events.json()["total"] == 1
    assert client.delete(
        f"/api/v1/maintenance/{record_id}/permanent"
    ).status_code == 204
    assert client.get(f"/api/v1/maintenance/{record_id}").status_code == 404
    assert client.get(
        f"/api/v1/maintenance?asset_id={asset_id}&include_archived=true"
    ).json()["total"] == 0
    permanent_events = client.get(
        f"/api/v1/events?asset_id={asset_id}&event_type=maintenance_record_permanently_deleted"
    )
    assert permanent_events.status_code == 200
    assert permanent_events.json()["total"] == 1
    assert permanent_events.json()["items"][0]["metadata"]["deleted_record_id"] == record_id


def test_unstarted_maintenance_can_be_permanently_deleted(client):
    asset_id = create_asset(client, "Unstarted deletion asset")
    created = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "title": "Unstarted inspection",
            "maintenance_type": "inspection",
            "status": "planned",
            "planned_start_at": "2026-11-01T08:00:00Z",
            "planned_end_at": "2026-11-01T10:00:00Z",
            "notes": "Not started yet",
        },
    )
    assert created.status_code == 201, created.text
    record_id = created.json()["id"]

    started = client.post(f"/api/v1/maintenance/{record_id}/start")
    assert started.status_code == 200, started.text
    assert client.delete(
        f"/api/v1/maintenance/{record_id}/permanent"
    ).status_code == 409

    cancelled = client.post(f"/api/v1/maintenance/{record_id}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    deleted = client.delete(f"/api/v1/maintenance/{record_id}/permanent")
    assert deleted.status_code == 204, deleted.text
    assert client.get(f"/api/v1/maintenance/{record_id}").status_code == 404
    assert client.get(
        f"/api/v1/maintenance?asset_id={asset_id}"
    ).json()["total"] == 0
    events = client.get(
        f"/api/v1/events?asset_id={asset_id}&event_type=maintenance_record_permanently_deleted"
    )
    assert events.status_code == 200
    assert events.json()["items"][0]["metadata"]["deleted_record_id"] == record_id


def test_schedule_can_be_deleted_when_no_occurrence_is_in_progress(client):
    asset_id = create_asset(client, "Unstarted schedule deletion asset")
    created = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Unstarted schedule",
            "maintenance_type": "preventive",
            "schedule_start_date": "2026-10-20",
            "first_due_date": "2026-11-20",
            "recurrence_enabled": True,
            "recurrence_interval": 1,
            "recurrence_unit": "months",
        },
    )
    assert created.status_code == 201, created.text
    schedule_id = created.json()["id"]
    occurrence_id = created.json()["current_occurrence_id"]

    deleted = client.delete(
        f"/api/v1/maintenance/schedules/{schedule_id}/permanent"
    )
    assert deleted.status_code == 204, deleted.text
    assert client.get(
        f"/api/v1/maintenance/schedules/{schedule_id}"
    ).status_code == 404
    assert client.get(f"/api/v1/maintenance/{occurrence_id}").status_code == 404
    events = client.get(
        f"/api/v1/events?asset_id={asset_id}&event_type=maintenance_schedule_permanently_deleted"
    )
    assert events.status_code == 200
    assert events.json()["items"][0]["metadata"]["deleted_schedule_id"] == schedule_id

    completed_schedule = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Schedule with completed history",
            "maintenance_type": "inspection",
            "schedule_start_date": "2026-10-20",
            "first_due_date": "2026-11-20",
        },
    )
    assert completed_schedule.status_code == 201, completed_schedule.text
    history_id = completed_schedule.json()["current_occurrence_id"]
    completed = client.post(f"/api/v1/maintenance/{history_id}/complete")
    assert completed.status_code == 200, completed.text
    deleted_with_history = client.delete(
        f"/api/v1/maintenance/schedules/{completed_schedule.json()['id']}/permanent"
    )
    assert deleted_with_history.status_code == 204, deleted_with_history.text
    assert client.get(f"/api/v1/maintenance/{history_id}").status_code == 404

    in_progress_schedule = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Schedule with active work",
            "maintenance_type": "inspection",
            "schedule_start_date": "2026-10-20",
            "first_due_date": "2026-11-20",
        },
    )
    assert in_progress_schedule.status_code == 201, in_progress_schedule.text
    active_occurrence_id = in_progress_schedule.json()["current_occurrence_id"]
    started = client.post(
        f"/api/v1/maintenance/{active_occurrence_id}/start"
    )
    assert started.status_code == 200, started.text
    blocked = client.delete(
        f"/api/v1/maintenance/schedules/{in_progress_schedule.json()['id']}/permanent"
    )
    assert blocked.status_code == 409
    assert client.get(
        f"/api/v1/maintenance/schedules/{in_progress_schedule.json()['id']}"
    ).status_code == 200
    cancelled = client.post(
        f"/api/v1/maintenance/{active_occurrence_id}/cancel"
    )
    assert cancelled.status_code == 200, cancelled.text
    deleted_from_job = client.delete(
        f"/api/v1/maintenance/{active_occurrence_id}/permanent"
    )
    assert deleted_from_job.status_code == 204, deleted_from_job.text
    assert client.get(
        f"/api/v1/maintenance/schedules/{in_progress_schedule.json()['id']}"
    ).status_code == 404
    assert client.get(
        f"/api/v1/maintenance/{active_occurrence_id}"
    ).status_code == 404


def test_schedule_day_progress_is_inclusive_and_tracks_current_due_date(client):
    asset_id = create_asset(client, "Schedule counter asset")
    today = datetime.now(timezone.utc).date()
    schedule_start = today - timedelta(days=10)
    first_due = today + timedelta(days=19)
    created = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Counted maintenance",
            "maintenance_type": "preventive",
            "schedule_start_date": schedule_start.isoformat(),
            "first_due_date": first_due.isoformat(),
        },
    )
    assert created.status_code == 201, created.text
    schedule = created.json()
    assert schedule["current_period_start_date"] == schedule_start.isoformat()
    assert schedule["total_days"] == 30
    assert schedule["current_day_count"] == 11


def test_maintenance_dates_asset_validation_and_cancellation_preserve_history(client):
    asset_id = create_asset(client, "Maintenance asset")
    missing_asset = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": 999999,
            "title": "Missing asset job",
            "planned_start_at": "2026-10-22T09:00:00Z",
            "planned_end_at": "2026-10-22T11:00:00Z",
            "notes": "This should not be stored.",
        },
    )
    assert missing_asset.status_code == 404

    bad_planned_dates = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "title": "Invalid planned range",
            "planned_start_at": "2026-10-22T11:00:00Z",
            "planned_end_at": "2026-10-22T09:00:00Z",
            "notes": "The end is before the start.",
        },
    )
    assert bad_planned_dates.status_code == 422

    bad_actual_dates = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "title": "Invalid actual range",
            "planned_start_at": "2026-10-22T09:00:00Z",
            "planned_end_at": "2026-10-22T11:00:00Z",
            "actual_started_at": "2026-10-22T11:00:00Z",
            "actual_completed_at": "2026-10-22T10:00:00Z",
            "notes": "The completion is before the start.",
        },
    )
    assert bad_actual_dates.status_code == 422

    created = client.post(
        "/api/v1/maintenance",
        json={
            "asset_id": asset_id,
            "title": "Cancelled maintenance",
            "planned_start_at": "2026-10-22T09:00:00Z",
            "planned_end_at": "2026-10-22T11:00:00Z",
            "notes": "Job retained for the audit trail.",
        },
    )
    assert created.status_code == 201, created.text
    record_id = created.json()["id"]
    cancelled = client.post(f"/api/v1/maintenance/{record_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert client.get(f"/api/v1/maintenance/{record_id}").status_code == 200
    assert client.get(f"/api/v1/maintenance?asset_id={asset_id}").json()["total"] == 1


def test_calendar_recurrence_uses_anchor_for_month_ends_and_leap_years():
    assert next_due_date(
        datetime(2026, 10, 19).date(),
        interval=1,
        unit="months",
        after=datetime(2026, 11, 19).date(),
    ).isoformat() == "2026-12-19"
    assert next_due_date(
        datetime(2026, 1, 31).date(),
        interval=1,
        unit="months",
        after=datetime(2026, 1, 31).date(),
    ).isoformat() == "2026-02-28"
    assert next_due_date(
        datetime(2026, 1, 31).date(),
        interval=1,
        unit="months",
        after=datetime(2026, 2, 28).date(),
    ).isoformat() == "2026-03-31"
    assert next_due_date(
        datetime(2024, 2, 29).date(),
        interval=1,
        unit="years",
        after=datetime(2024, 2, 29).date(),
    ).isoformat() == "2025-02-28"
    assert next_due_date(
        datetime(2024, 2, 29).date(),
        interval=1,
        unit="years",
        after=datetime(2025, 2, 28).date(),
    ).isoformat() == "2026-02-28"
    assert next_due_date(
        datetime(2026, 10, 19).date(),
        interval=2,
        unit="weeks",
        after=datetime(2026, 10, 19).date(),
    ).isoformat() == "2026-11-02"
    assert next_due_date(
        datetime(2026, 10, 19).date(),
        interval=2,
        unit="weeks",
        after=datetime(2026, 11, 3).date(),
    ).isoformat() == "2026-11-16"
    assert next_due_date(
        datetime(2026, 10, 19).date(),
        interval=3,
        unit="days",
        after=datetime(2026, 10, 19).date(),
    ).isoformat() == "2026-10-22"


def test_maintenance_due_state_boundaries():
    due = datetime(2026, 11, 19).date()
    assert due_status(due, today=due.replace(day=18)) == "upcoming"
    assert due_status(due, today=due) == "due_today"
    assert due_status(due, today=due.replace(day=20)) == "overdue"
    assert due_status(due, today=due, completed=True) == "completed"
    assert due_status(due, today=due, awaiting_approval=True) == "awaiting_approval"


def test_recurring_schedule_completion_and_approval_are_idempotent(client):
    asset_id = create_asset(client, "Recurring maintenance asset")
    created = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Monthly motor service",
            "maintenance_type": "preventive",
            "priority": "high",
            "assigned_technician": "Alex",
            "description": "Inspect the motor and bearings.",
            "schedule_start_date": "2026-10-19",
            "first_due_date": "2026-11-19",
            "recurrence_enabled": True,
            "recurrence_interval": 1,
            "recurrence_unit": "months",
        },
    )
    assert created.status_code == 201, created.text
    schedule = created.json()
    assert schedule["current_due_date"] == "2026-11-19"
    occurrence_id = schedule["current_occurrence_id"]
    occurrence = client.get(f"/api/v1/maintenance/{occurrence_id}")
    assert occurrence.status_code == 200
    assert occurrence.json()["schedule_id"] == schedule["id"]
    assert occurrence.json()["planned_due_date"] == "2026-11-19"

    completed = client.post(f"/api/v1/maintenance/{occurrence_id}/complete")
    assert completed.status_code == 200, completed.text
    pending = client.get(f"/api/v1/maintenance/schedules/{schedule['id']}").json()
    assert pending["approval_status"] == "pending"
    assert pending["proposed_due_date"] == "2026-12-19"
    assert pending["current_due_date"] == "2026-11-19"
    assert pending["last_completed_at"] == completed.json()["actual_completed_at"]

    changed_due = "2026-12-20"
    confirmed = client.post(
        f"/api/v1/maintenance/schedules/{schedule['id']}/confirm-next",
        json={"due_date": changed_due},
    )
    assert confirmed.status_code == 200, confirmed.text
    new_occurrence_id = confirmed.json()["current_occurrence_id"]
    assert new_occurrence_id != occurrence_id
    assert confirmed.json()["current_due_date"] == changed_due
    repeated = client.post(
        f"/api/v1/maintenance/schedules/{schedule['id']}/confirm-next",
        json={"due_date": changed_due},
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["current_occurrence_id"] == new_occurrence_id
    assert repeated.json()["current_period_start_date"] == "2026-11-20"
    assert repeated.json()["total_days"] == 31
    assert client.get(f"/api/v1/maintenance/{occurrence_id}").json()["status"] == "completed"
    assert client.get(
        f"/api/v1/maintenance?asset_id={asset_id}"
    ).json()["total"] == 2


def test_declining_recurring_occurrence_retains_history_and_stops_recurrence(client):
    asset_id = create_asset(client, "Decline maintenance asset")
    created = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Quarterly inspection",
            "maintenance_type": "inspection",
            "schedule_start_date": "2026-10-01",
            "first_due_date": "2026-11-01",
            "recurrence_enabled": True,
            "recurrence_interval": 3,
            "recurrence_unit": "months",
        },
    )
    assert created.status_code == 201, created.text
    schedule = created.json()
    completed = client.post(
        f"/api/v1/maintenance/{schedule['current_occurrence_id']}/complete"
    )
    assert completed.status_code == 200
    declined = client.post(
        f"/api/v1/maintenance/schedules/{schedule['id']}/decline-next"
    )
    assert declined.status_code == 200
    assert declined.json()["approval_status"] == "declined"
    assert declined.json()["status"] == "completed"
    assert declined.json()["proposed_due_date"] is None
    assert client.get(
        f"/api/v1/maintenance/{schedule['current_occurrence_id']}"
    ).json()["status"] == "completed"


def test_due_date_alert_event_is_persisted_once_per_occurrence(client):
    asset_id = create_asset(client, "Due alert asset")
    yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
    created = client.post(
        "/api/v1/maintenance/schedules",
        json={
            "asset_id": asset_id,
            "title": "Overdue inspection",
            "maintenance_type": "inspection",
            "schedule_start_date": yesterday,
            "first_due_date": yesterday,
        },
    )
    assert created.status_code == 201, created.text
    with client.app.state.session_factory() as session:
        assert emit_due_schedule_events(
            session, today=datetime.now(timezone.utc).date()
        ) == 1
    with client.app.state.session_factory() as session:
        assert emit_due_schedule_events(
            session, today=datetime.now(timezone.utc).date()
        ) == 0
    events = client.get(
        f"/api/v1/events?asset_id={asset_id}&event_type=maintenance_due"
    )
    assert events.status_code == 200, events.text
    assert events.json()["total"] == 1
    active_alerts = client.get(f"/api/v1/alerts/active?asset_id={asset_id}")
    assert active_alerts.status_code == 200, active_alerts.text
    assert active_alerts.json()["total"] == 1
    alert = active_alerts.json()["items"][0]
    assert alert["rule_id"] is None
    assert alert["maintenance_schedule_id"] == created.json()["id"]

    completed = client.post(
        f"/api/v1/maintenance/{created.json()['current_occurrence_id']}/complete"
    )
    assert completed.status_code == 200
    assert client.get(f"/api/v1/alerts/active?asset_id={asset_id}").json()["total"] == 0


def test_dashboard_serves_ui_and_redirects_root(client):
    root = client.get("/")
    assert root.status_code == 200
    frontend_build = Path(__file__).resolve().parents[2] / "Nem_Frontend" / "dist"
    if not frontend_build.is_dir():
        assert root.url.path == "/docs"
        return
    assert root.url.path == "/ui/"
    page = client.get("/ui/")
    assert page.status_code == 200
    assert "NEM Monitor" in page.text
    script_path = re.search(r'src="([^"]+\.js)"', page.text).group(1)
    script = client.get(script_path)
    assert script.status_code == 200
    assert "assets" in script.text
    assert client.get("/ui/plc").status_code == 200
