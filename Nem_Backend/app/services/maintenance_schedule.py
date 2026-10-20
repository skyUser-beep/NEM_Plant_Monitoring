from calendar import monthrange
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Alert, MaintenanceSchedule
from app.services.monitoring_engine import emit_event

RECURRENCE_UNITS = {"days", "weeks", "months", "years"}


def due_status(
    due_date: date | None,
    *,
    today: date,
    completed: bool = False,
    cancelled: bool = False,
    awaiting_approval: bool = False,
) -> str:
    if completed:
        return "completed"
    if awaiting_approval:
        return "awaiting_approval"
    if cancelled or due_date is None:
        return "not_scheduled"
    if due_date < today:
        return "overdue"
    if due_date == today:
        return "due_today"
    return "upcoming"


def next_due_date(
    anchor: date,
    *,
    interval: int,
    unit: str,
    after: date,
) -> date:
    if interval < 1 or unit not in RECURRENCE_UNITS:
        raise ValueError("Recurrence interval and unit are invalid")
    if unit == "days":
        step_days = interval
        cycles = max(1, (after - anchor).days // step_days + 1)
        return anchor + timedelta(days=cycles * step_days)
    if unit == "weeks":
        step_days = interval * 7
        cycles = max(1, (after - anchor).days // step_days + 1)
        return anchor + timedelta(days=cycles * step_days)

    anchor_month = anchor.year * 12 + anchor.month - 1
    after_month = after.year * 12 + after.month - 1
    step = interval if unit == "months" else interval * 12
    cycles = max(1, (after_month - anchor_month) // step + 1)
    target_month = anchor_month + cycles * step
    year, month_index = divmod(target_month, 12)
    month = month_index + 1
    return date(year, month, min(anchor.day, monthrange(year, month)[1]))


def emit_due_schedule_events(session: Session, *, today: date) -> int:
    due_schedules = session.scalars(
        select(MaintenanceSchedule)
        .where(
            MaintenanceSchedule.status == "active",
            MaintenanceSchedule.current_due_date <= today,
            MaintenanceSchedule.approval_status.in_(("not_required", "approved")),
        )
        .with_for_update()
    ).all()
    emitted = 0
    changed = False
    now = datetime.now(timezone.utc)
    for schedule in due_schedules:
        state = due_status(schedule.current_due_date, today=today)
        alert = session.scalar(
            select(Alert).where(
                Alert.maintenance_schedule_id == schedule.id,
                Alert.maintenance_due_date == schedule.current_due_date,
                Alert.status == "active",
            )
        )
        alert_title = f"Maintenance {state.replace('_', ' ')}"
        alert_message = f"{schedule.title} was due {schedule.current_due_date}."
        already_alerted = schedule.due_alerted_for == schedule.current_due_date
        if already_alerted and alert is not None:
            if (
                alert.title != alert_title or alert.message != alert_message
            ):
                alert.title = alert_title
                alert.message = alert_message
                alert.last_updated_at = now
                changed = True
            continue
        if alert is None:
            alert = Alert(
                rule_id=None,
                maintenance_schedule_id=schedule.id,
                maintenance_due_date=schedule.current_due_date,
                target_asset_id=schedule.asset_id,
                severity="warning",
                title=alert_title,
                message=alert_message,
                trigger_value=None,
                threshold=None,
                status="active",
                started_at=now,
                last_updated_at=now,
            )
            session.add(alert)
            session.flush()
        if already_alerted:
            changed = True
            continue
        emit_event(
            session,
            event_type="maintenance_due",
            message=f"Maintenance {state.replace('_', ' ')}: {schedule.title} was due {schedule.current_due_date}.",
            occurred_at=now,
            asset_id=schedule.asset_id,
            alert_id=alert.id,
            severity="warning",
            metadata={
                "maintenance_schedule_id": schedule.id,
                "due_date": schedule.current_due_date.isoformat(),
            },
        )
        schedule.due_alerted_for = schedule.current_due_date
        emitted += 1
        changed = True
    if changed:
        session.commit()
    return emitted
