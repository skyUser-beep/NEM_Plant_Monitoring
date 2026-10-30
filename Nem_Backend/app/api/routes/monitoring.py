# Lets user evaluate monitoring rules,inspect machine status,view active alerts,acknowledge alerts and review the event history
from datetime import datetime, timezone # work with timestamps and UTC
# Groups API Endpoints
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
#func -> SQL Function, or_ -> Combines SQL Condition using OR, select -> constructs SQL queries
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
#Represents the SQLAlchemy database session
from sqlalchemy.orm import Session

from app.api.routes.auth import require_roles
from app.db.session import get_db
from app.models import (
    Alert, 
    Asset,
    MonitoringEvent,
    MonitoringRule,
    RuleState, # stores the current state associated with a rule and target
    User, # stores the current state associated with a rule and target
    Variable, # represents a monitored variable belonging to an asset
)
from app.schemas.monitoring import (
    AlertRead,
    EvaluationResult,
    EventRead,
    RuleStateRead,
)
from app.services.monitoring_engine import (
    emit_event,
    evaluate_rules,
    set_rule_enabled_state,
    utc_now,
)

router = APIRouter(tags=["monitoring", "alerts", "events"])

# normalized -> Ensures that a datetime value is in UTC format, converting it if necessary. If the input is None, it returns None. This is useful for consistent timestamp handling across the application.
def normalized(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

#  state_for_rule -> Retrieves the current state of a given monitoring rule. It checks if the rule is associated with an asset or variable, fetches the corresponding RuleState from the database, and returns it in a structured format. If no state is found, it returns a default "unknown" state indicating that the rule has not yet been evaluated.
# reads the stored state
def state_for_rule(session: Session, rule: MonitoringRule) -> RuleStateRead:
    asset_id = rule.target_asset_id
    if asset_id is None and rule.variable_id is not None:
        variable = session.get(Variable, rule.variable_id)
        asset_id = variable.asset_id if variable else None
    state = session.scalar(
        select(RuleState).where(
            RuleState.rule_id == rule.id,
            RuleState.target_asset_id == asset_id,
        )
    ) if asset_id is not None else None
    if state is None:
        return RuleStateRead(
            rule_id=rule.id,
            target_asset_id=asset_id,
            target_variable_id=rule.variable_id,
            status="unknown",
            message="Rule has not yet been evaluated.",
        )
    return RuleStateRead.model_validate(state)

# Manually evaluating monitoring rules
@router.post("/monitoring/evaluate", response_model=EvaluationResult)
def manually_evaluate(
    request: Request,
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    session: Session = Depends(get_db),
) -> dict[str, int]:
    #Validate the asset
    if asset_id is not None and session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    #Validate the rule
    if rule_id is not None and session.get(MonitoringRule, rule_id) is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    #Call the monitoring engine
    counts = evaluate_rules(
        session,
        #configure threshold for treating data as stale
        stale_after_seconds=request.app.state.settings.monitoring_default_stale_after_seconds,
        asset_id=asset_id,
        rule_id=rule_id,
    )
    session.commit()
    return counts

# Getting the status of monitoring rules
@router.get("/monitoring/status")
def monitoring_status(
    status: str | None = Query(default=None, pattern="^(normal|warning|alert|unknown)$"),
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    query = select(MonitoringRule).where(
        MonitoringRule.is_enabled.is_(True),
        MonitoringRule.is_archived.is_(False),
    )
    if rule_id is not None:
        query = query.where(MonitoringRule.id == rule_id)
    rules = session.scalars(query.order_by(MonitoringRule.id)).all()
    rows: list[RuleStateRead] = []
    for rule in rules:
        current = state_for_rule(session, rule) # to obtain the current state of the rule or unknown fallback
        if asset_id is not None and current.target_asset_id != asset_id:
            continue
        if status is not None and current.status != status:
            continue
        rows.append(current)
    return {
        "items": rows[offset : offset + limit],
        "total": len(rows),
        "limit": limit,
        "offset": offset,
    }

#Getting monitoring status for a specific asset
@router.get("/assets/{asset_id}/monitoring-status")
def asset_monitoring_status(
    asset_id: int,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    # Verify the asset exists
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    # fine rules associated with that asset
    rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.is_enabled.is_(True),
            MonitoringRule.is_archived.is_(False),
            or_(
                MonitoringRule.target_asset_id == asset_id,
                MonitoringRule.variable_id.in_(
                    select(Variable.id).where(Variable.asset_id == asset_id)
                ),
            ),
        )
        .order_by(MonitoringRule.id)
    ).all()
    items = [state_for_rule(session, rule) for rule in rules]
    return {"items": items[offset : offset + limit], "total": len(items), "limit": limit, "offset": offset}

# Getting the status of a specific rule 
@router.get("/rules/{rule_id}/status", response_model=RuleStateRead)
def rule_status(rule_id: int, session: Session = Depends(get_db)) -> RuleStateRead:
    rule = session.get(MonitoringRule, rule_id)
    if rule is None or rule.is_archived:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    return state_for_rule(session, rule)


def alert_query(
    session: Session,
    *,
    asset_id: int | None,
    rule_id: int | None,
    severity: str | None,
    lifecycle_status: str | None,
    acknowledged: bool | None,
    start_time: datetime | None,
    end_time: datetime | None,
):
    start, end = normalized(start_time), normalized(end_time)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start_time must not be later than end_time")
    query = select(Alert)
    count_query = select(func.count()).select_from(Alert)
    filters = []
    if asset_id is not None:
        filters.append(Alert.target_asset_id == asset_id)
    if rule_id is not None:
        filters.append(Alert.rule_id == rule_id)
    if severity is not None:
        filters.append(Alert.severity == severity)
    if lifecycle_status is not None:
        filters.append(Alert.status == lifecycle_status)
        if lifecycle_status == "active":
            query = query.outerjoin(MonitoringRule, MonitoringRule.id == Alert.rule_id)
            count_query = count_query.outerjoin( MonitoringRule, MonitoringRule.id == Alert.rule_id)
            filters.extend(
                [
                    or_(
                        Alert.maintenance_schedule_id.is_not(None),
                        and_(
                            MonitoringRule.is_enabled.is_(True),
                            MonitoringRule.is_archived.is_(False),
                        ),
                    ),
                ]
            )
    if acknowledged is True:
        filters.append(Alert.acknowledged_at.is_not(None))
    if acknowledged is False:
        filters.append(Alert.acknowledged_at.is_(None))
    if start is not None:
        filters.append(Alert.started_at >= start)
    if end is not None:
        filters.append(Alert.started_at <= end)
    for condition in filters:
        query, count_query = query.where(condition), count_query.where(condition)
    return query, count_query


#Listing active alerts 
@router.get("/alerts/active")
def active_alerts(
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    severity: str | None = Query(default=None, pattern="^(warning|alert)$"),
    acknowledged: bool | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    query, count_query = alert_query(
        session, asset_id=asset_id, rule_id=rule_id, severity=severity,
        lifecycle_status="active", acknowledged=acknowledged,
        start_time=start_time, end_time=end_time,
    )
    rows = session.scalars(
        query.order_by(Alert.started_at.desc(), Alert.id.desc()).offset(offset).limit(limit)
    ).all()
    return {
        "items": [AlertRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

# Listing all alerts (active and resolved)
@router.get("/alerts")
def list_alerts(
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    severity: str | None = Query(default=None, pattern="^(warning|alert)$"),
    lifecycle_status: str | None = Query(default=None, pattern="^(active|resolved)$"),
    acknowledged: bool | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    query, count_query = alert_query(
        session, asset_id=asset_id, rule_id=rule_id, severity=severity,
        lifecycle_status=lifecycle_status, acknowledged=acknowledged,
        start_time=start_time, end_time=end_time,
    )
    rows = session.scalars(
        query.order_by(Alert.started_at.desc(), Alert.id.desc()).offset(offset).limit(limit)
    ).all()
    return {
        "items": [AlertRead.model_validate(row) for row in rows],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

# Retrieving a specific alert by its ID
@router.get("/alerts/{alert_id}", response_model=AlertRead)
def get_alert(alert_id: int, session: Session = Depends(get_db)) -> Alert:
    alert = session.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} was not found")
    return alert

# Acknowledging an active alert
@router.post("/alerts/{alert_id}/acknowledge", response_model=AlertRead)
def acknowledge_alert(
    alert_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> Alert:
    # find the alert
    alert = session.scalar(select(Alert).where(Alert.id == alert_id).with_for_update())
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} was not found")
    user_id = getattr(request.state, "auth_user_id", None)
    user = session.get(User, user_id) if user_id is not None else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Authentication required")
    #Prevent acknowledging resolved alerts
    if alert.status != "active":
        raise HTTPException(status_code=409, detail="Resolved alerts cannot be acknowledged")
    # Check whether it has already been acknowledged
    if alert.acknowledged_at is None:
        now = utc_now()
        alert.acknowledged_at = now
        alert.acknowledged_by = user.username
        #Emit an acknowledgment event 
        emit_event(
            session,
            event_type="alert_acknowledged",
            message="Active alert acknowledged; the underlying condition is not resolved.",
            occurred_at=now,
            asset_id=alert.target_asset_id,
            rule_id=alert.rule_id,
            alert_id=alert.id,
            severity=alert.severity,
            metadata={
                "acknowledged_by": alert.acknowledged_by,
                "acknowledged_at": now.isoformat(),
                "identity_verified": True,
                "outcome": "acknowledged_not_resolved",
            },
        )
        session.commit()
        session.refresh(alert)
    return alert

#When the alert is mark as completed
@router.post("/alerts/{alert_id}/complete", response_model=AlertRead)
def complete_rule_from_alert(
    alert_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> Alert:
    alert = session.scalar(select(Alert).where(Alert.id == alert_id).with_for_update())
    if alert is None:
        raise HTTPException(status_code=404, detail=f"Alert {alert_id} was not found")
    if alert.status != "active":
        raise HTTPException(status_code=409, detail="Resolved alerts cannot complete a rule")
    user_id = getattr(request.state, "auth_user_id", None)
    user = session.get(User, user_id) if user_id is not None else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Authentication required")
    if alert.rule_id is None:
        raise HTTPException(status_code=409,detail="Maintenance alerts must be resolved through maintenance scheduling.",)

    rule = session.scalar(
        select(MonitoringRule)
        .where(MonitoringRule.id == alert.rule_id)
        .with_for_update()
    )
    if (
        rule is None
        or rule.is_archived
        or rule.lifecycle_status != "in_progress"
        or not rule.is_enabled
    ):
        raise HTTPException(status_code=409,detail="Only an active monitoring rule can be completed from an alert.",)
    state = session.scalar(
        select(RuleState).where(
            RuleState.rule_id == rule.id,
            RuleState.target_asset_id == alert.target_asset_id,
        )
    )
    if state is None or state.status not in {"warning", "alert"}:
        raise HTTPException(status_code=409,detail="The monitoring rule no longer has an active warning or alert.",)

    now = utc_now()
    if alert.acknowledged_at is None:
        alert.acknowledged_at = now
        alert.acknowledged_by = user.username
        emit_event(
            session,
            event_type="alert_acknowledged",
            message="Alert acknowledged as resolved and ready for completion.",
            occurred_at=now,
            asset_id=alert.target_asset_id,
            rule_id=alert.rule_id,
            alert_id=alert.id,
            severity=alert.severity,
            metadata={
                "acknowledged_by": user.username,
                "acknowledged_at": now.isoformat(),
                "identity_verified": True,
                "outcome": "acknowledged_and_completed",
            },
        )
    set_rule_enabled_state(session, rule, False, at=now)
    rule.lifecycle_status = "completed"
    rule.completed_at = now
    emit_event(
        session,
        event_type="rule_completed",
        message=f"Rule '{rule.name}' marked completed after alert resolution.",
        occurred_at=now,
        asset_id=rule.target_asset_id,
        rule_id=rule.id,
        alert_id=alert.id,
        severity=alert.severity,
        metadata={
            "acknowledged_by": alert.acknowledged_by,
            "acknowledged_at": alert.acknowledged_at.isoformat(),
            "completed_by": user.username,
            "completed_at": now.isoformat(),
            "outcome": "rule_successfully_completed",
        },
    )
    session.commit()
    session.refresh(alert)
    return alert

#Listing monitoring events
@router.get("/events")
def list_events(
    asset_id: int | None = Query(default=None, gt=0),
    rule_id: int | None = Query(default=None, gt=0),
    alert_id: int | None = Query(default=None, gt=0),
    event_type: str | None = None,
    severity: str | None = Query(default=None, pattern="^(warning|alert)$"),
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    start, end = normalized(start_time), normalized(end_time)
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="start_time must not be later than end_time")
    query = (
        select(MonitoringEvent, Asset.name, MonitoringRule.name)
        .outerjoin(Asset, Asset.id == MonitoringEvent.asset_id)
        .outerjoin(MonitoringRule, MonitoringRule.id == MonitoringEvent.rule_id)
    )
    count_query = select(func.count()).select_from(MonitoringEvent)
    for value, column in (
        (asset_id, MonitoringEvent.asset_id),
        (rule_id, MonitoringEvent.rule_id),
        (alert_id, MonitoringEvent.alert_id),
        (event_type, MonitoringEvent.event_type),
        (severity, MonitoringEvent.severity),
    ):
        if value is not None:
            query, count_query = query.where(column == value), count_query.where(column == value)
    if start is not None:
        query, count_query = query.where(MonitoringEvent.occurred_at >= start), count_query.where(MonitoringEvent.occurred_at >= start)
    if end is not None:
        query, count_query = query.where(MonitoringEvent.occurred_at <= end), count_query.where(MonitoringEvent.occurred_at <= end)
    rows = session.execute(
        query.order_by(MonitoringEvent.occurred_at.desc(), MonitoringEvent.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return {
        "items": [
            {
                **EventRead.model_validate(event).model_dump(),
                "asset_name": asset_name,
                "rule_name": rule_name,
            }
            for event, asset_name, rule_name in rows
        ],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

#Retrieving one event 
@router.get("/events/{event_id}", response_model=EventRead)
def get_event(event_id: int, session: Session = Depends(get_db)) -> MonitoringEvent:
    event = session.get(MonitoringEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail=f"Event {event_id} was not found")
    return event

@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_event(
    event_id: int,
    session: Session = Depends(get_db),
    user: User = Depends(require_roles("Administrator")),
) -> Response:
    event = session.get(MonitoringEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail=f"Event {event_id} was not found")
    try:
        session.delete(event)
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="This event is referenced by retained history and cannot be deleted.",
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)

# A reading arrives -> the monitoring engine evaluates the rules -> dashboard request the status -> dashboard display the alert -> an operator acknowledge the alert -> the dashboard displays the history