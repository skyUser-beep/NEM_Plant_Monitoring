
import logging
import math
import operator
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import (
    Alert,
    Asset,
    MachineMonitoringState,
    MonitoringEvent,
    MonitoringRule,
    Reading,
    RuleCounterState,
    RuleState,
    SchedulerLease,
    Variable,
)

from app.services.email_notifications import enqueue_alert_notifications

LOGGER = logging.getLogger("nem_backend.monitoring")

OPERATORS: dict[str, Callable[[Any, Any], bool]] = {
    ">": operator.gt,
    ">=": operator.ge,
    "<": operator.lt,
    "<=": operator.le,
    "==": operator.eq,
    "!=": operator.ne,
    "gt": operator.gt,
    "gte": operator.ge,
    "lt": operator.lt,
    "lte": operator.le,
    "eq": operator.eq,
    "ne": operator.ne,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def runtime_activation_at(rule: MonitoringRule) -> datetime | None:
    value = (rule.parameters or {}).get("activation_at")
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Runtime activation timestamp must be an ISO-8601 string")
    try:
        activation_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Runtime activation timestamp is invalid") from error
    if activation_at.tzinfo is None or activation_at.utcoffset() is None:
        raise ValueError("Runtime activation timestamp must include a timezone")
    return activation_at.astimezone(timezone.utc)


def emit_event(
    session: Session,
    *,
    event_type: str,
    message: str,
    occurred_at: datetime,
    asset_id: int | None = None,
    rule_id: int | None = None,
    alert_id: int | None = None,
    severity: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> MonitoringEvent:
    event = MonitoringEvent(
        event_type=event_type,
        message=message,
        occurred_at=occurred_at,
        asset_id=asset_id,
        rule_id=rule_id,
        alert_id=alert_id,
        severity=severity,
        event_metadata=metadata,
    )
    session.add(event)
    return event


def get_rule_asset(
    session: Session,
    rule: MonitoringRule,
) -> tuple[Asset | None, Variable | None]:
    variable = (
        session.get(Variable, rule.variable_id)
        if rule.variable_id is not None
        else None
    )
    asset_id = rule.target_asset_id or (variable.asset_id if variable else None)
    asset = session.get(Asset, asset_id) if asset_id is not None else None
    return asset, variable


def current_state(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
) -> RuleState | None:
    return session.scalar(
        select(RuleState).where(
            RuleState.rule_id == rule.id,
            RuleState.target_asset_id == asset.id,
        )
    )


def _condition_holds(rule: MonitoringRule, value: Any) -> bool:
    if rule.rule_type == "parameter_threshold":
        comparison = rule.operator
        threshold: Any = rule.threshold
        expected_value = (rule.parameters or {}).get("expected_value")
        if isinstance(expected_value, bool):
            if comparison not in {"==", "!=", "eq", "ne"} or not isinstance(value, bool):
                raise ValueError("Boolean parameter threshold has an invalid comparison")
            return value == expected_value if comparison in {"==", "eq"} else value != expected_value
    else:
        parameters = rule.parameters or {}
        condition = parameters.get("condition", "equals")

        if condition == "equals":
            if (
                "expected_value" not in parameters
                and "equals" not in parameters
            ):
                raise ValueError("Duration equals condition has no configured expected_value")
            return value == parameters.get("expected_value", parameters.get("equals"),)

        if condition != "threshold":
            raise ValueError("Unsupported duration condition")

        comparison = parameters.get("operator")
        threshold = parameters.get("threshold")

    if comparison not in OPERATORS or threshold is None:
        raise ValueError("Rule has an invalid comparison configuration")

    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ValueError("Rule requires a numeric reading")

    return OPERATORS[comparison](value, threshold)

def _valid_value(variable: Variable, value: Any) -> bool:
    return (
        (
            variable.data_type == "number"
            and isinstance(value, (int, float))
            and not isinstance(value, bool)
        )
        or (
            variable.data_type == "integer"
            and isinstance(value, int)
            and not isinstance(value, bool)
        )
        or (
            variable.data_type == "string"
            and isinstance(value, str)
        )
        or (
            variable.data_type == "boolean"
            and isinstance(value, bool)
        )
    )


def advance_rule_runtime(
    counter: RuleCounterState,
    at: datetime,
    stale_after_seconds: int,
    activation_at: datetime | None = None,
) -> None:
    if counter.is_running is not True or counter.last_signal_at is None:
        return
    latest_trustworthy_time = counter.last_signal_at + timedelta(seconds=stale_after_seconds)
    end = min(at, latest_trustworthy_time)
    checkpoint = counter.runtime_checkpoint_at
    runtime_start = max(checkpoint, activation_at) if (
        checkpoint is not None and activation_at is not None
    ) else checkpoint or activation_at
    if runtime_start is not None and end > runtime_start:
        counter.accumulated_running_seconds = Decimal(
            counter.accumulated_running_seconds
        ) + Decimal(str((end - runtime_start).total_seconds()))
        counter.runtime_checkpoint_at = end
        counter.updated_at = end


def current_rule_runtime_seconds(
    counter: RuleCounterState,
    at: datetime,
    stale_after_seconds: int,
    activation_at: datetime | None = None,
) -> Decimal:
    total = Decimal(counter.accumulated_running_seconds)
    if (
        counter.is_running is not True
        or counter.last_signal_at is None
        or counter.runtime_checkpoint_at is None
    ):
        return total
    end = min(
        at,
        counter.last_signal_at + timedelta(seconds=stale_after_seconds),
    )
    runtime_start = (
        max(counter.runtime_checkpoint_at, activation_at)
        if activation_at is not None
        else counter.runtime_checkpoint_at
    )
    if end > runtime_start:
        total += Decimal(
            str((end - runtime_start).total_seconds())
        )
    return total


def update_rule_signal_states(
    session: Session,
    *,
    asset_id: int,
    variable_id: int,
    value: Any,
    at: datetime,
    stale_after_seconds: int,
) -> None:
    if not isinstance(value, bool):
        return

    rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.target_asset_id == asset_id,
            MonitoringRule.variable_id == variable_id,
            MonitoringRule.rule_type.in_(
                {"boolean_count_threshold", "runtime_duration"}
            ),
            MonitoringRule.is_archived.is_(False),
        )
        .order_by(MonitoringRule.id)
        .with_for_update()
    ).all()
    for rule in rules:
        if rule.rule_type == "runtime_duration" and not rule.is_enabled:
            continue
        counter = session.scalar(
            select(RuleCounterState)
            .where(
                RuleCounterState.rule_id == rule.id,
                RuleCounterState.asset_id == asset_id,
            )
            .with_for_update()
        )
        if counter is None:
            counter = RuleCounterState(
                rule_id=rule.id,
                asset_id=asset_id,
                updated_at=at,
            )
            session.add(counter)
            session.flush()

        if counter.last_signal_at is not None and at <= counter.last_signal_at:
            continue

        if rule.rule_type == "boolean_count_threshold":
            signal_is_fresh = (
                counter.last_signal_at is not None
                and at - counter.last_signal_at
                <= timedelta(seconds=stale_after_seconds)
            )
            if (
                signal_is_fresh
                and counter.cycle_signal is False
                and value is True
            ):
                counter.cycle_count += 1
            counter.cycle_signal = value
        else:
            try:
                activation_at = runtime_activation_at(rule)
            except ValueError:
                LOGGER.warning(
                    "Skipping signal update for rule %s with invalid activation time",
                    rule.id,
                )
                continue
            advance_rule_runtime(
                counter,
                at,
                stale_after_seconds,
                activation_at,
            )
            counter.is_running = value
            counter.runtime_checkpoint_at = at if value else None

        counter.last_signal_at = at
        counter.updated_at = at


def _transition_state(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    state: RuleState | None,
    *,
    next_status: str,
    value: Any,
    message: str,
    evaluated_at: datetime,
    condition_started_at: datetime | None,
    error_message: str | None = None,
    threshold: Decimal | None = None,
    allow_new_occurrence: bool = False,
) -> RuleState:
    if state is None:
        state = RuleState(
            rule_id=rule.id,
            target_asset_id=asset.id,
            target_variable_id=rule.variable_id,
            status="unknown",
            message="No evaluation has been completed",
            last_evaluated_at=evaluated_at,
            last_transition_at=evaluated_at,
        )
        session.add(state)
        session.flush()

    previous_status = state.status
    previous_error = state.error_message
    transitioned = previous_status != next_status

    if transitioned:
        state.last_transition_at = evaluated_at

    state.status = next_status
    state.latest_value = value
    state.message = message
    state.last_evaluated_at = evaluated_at
    state.condition_started_at = condition_started_at
    state.error_message = error_message

    alert = session.scalar(
        select(Alert)
        .where(
            Alert.rule_id == rule.id,
            Alert.target_asset_id == asset.id,
            Alert.status == "active",
        )
        .order_by(Alert.id.desc())
        .limit(1)
    )

    if next_status in {"warning", "alert"}:
        can_create_alert = alert is not None or (
            allow_new_occurrence
            or _is_new_alert_occurrence(
                session,
                rule,
                asset,
                previous_status=previous_status,
            )
        )
        if alert is None and can_create_alert:
            alert = Alert(
                rule_id=rule.id,
                target_asset_id=asset.id,
                target_variable_id=rule.variable_id,
                severity=next_status,
                title=rule.name,
                message=message,
                trigger_value=value,
                threshold=threshold,
                status="active",
                started_at=evaluated_at,
                last_updated_at=evaluated_at,
            )
            session.add(alert)
            session.flush()
            enqueue_alert_notifications(session, alert, asset, rule)
        elif alert is not None:
            if alert.severity != next_status:
                previous_severity = alert.severity
                alert.severity = next_status
                enqueue_alert_notifications(session, alert, asset, rule)
                emit_event(
                    session,
                    event_type="alert_severity_changed",
                    message=(
                        f"Alert severity changed to {next_status}: {message}"
                    ),
                    occurred_at=evaluated_at,
                    asset_id=asset.id,
                    rule_id=rule.id,
                    alert_id=alert.id,
                    severity=next_status,
                    metadata={
                        "previous_severity": previous_severity,
                        "new_severity": next_status,
                    },
                )

            alert.message = message
            alert.trigger_value = value
            alert.threshold = threshold
            alert.last_updated_at = evaluated_at

        if transitioned and alert is not None:
            emit_event(
                session,
                event_type=(
                    "warning_triggered"
                    if next_status == "warning"
                    else "alert_triggered"
                ),
                message=message,
                occurred_at=evaluated_at,
                asset_id=asset.id,
                rule_id=rule.id,
                alert_id=alert.id,
                severity=next_status,
                metadata={
                    "value": value,
                    "threshold": (
                        str(threshold) if threshold is not None else None
                    ),
                },
            )

    elif next_status == "normal" and alert is not None:
        alert.status = "resolved"
        alert.resolved_at = evaluated_at
        alert.last_updated_at = evaluated_at
        emit_event(
            session,
            event_type="alert_resolved",
            message=f"Condition cleared: {rule.name}",
            occurred_at=evaluated_at,
            asset_id=asset.id,
            rule_id=rule.id,
            alert_id=alert.id,
            severity=alert.severity,
        )

    if (
        transitioned
        and previous_status in {"warning", "alert"}
        and next_status == "normal"
    ):
        emit_event(
            session,
            event_type="condition_returned_to_normal",
            message=f"Condition returned to normal: {rule.name}",
            occurred_at=evaluated_at,
            asset_id=asset.id,
            rule_id=rule.id,
        )

    if (
        next_status == "unknown"
        and error_message == "stale_reading"
        and previous_error != "stale_reading"
    ):
        emit_event(
            session,
            event_type="stale_data_detected",
            message=message,
            occurred_at=evaluated_at,
            asset_id=asset.id,
            rule_id=rule.id,
        )

    if (
        error_message not in {None, "stale_reading"}
        and (transitioned or previous_error != error_message)
    ):
        emit_event(
            session,
            event_type="evaluation_failure",
            message="Rule evaluation could not determine a valid state",
            occurred_at=evaluated_at,
            asset_id=asset.id,
            rule_id=rule.id,
            metadata={"reason": error_message},
        )
    return state


def _is_new_alert_occurrence(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    *,
    previous_status: str,
) -> bool:
    if previous_status in {"warning", "alert"}:
        return False
    if previous_status == "normal":
        return True

    previous_alert_exists = session.scalar(
        select(Alert.id)
        .where(
            Alert.rule_id == rule.id,
            Alert.target_asset_id == asset.id,
        )
        .limit(1)
    )
    if previous_alert_exists is None:
        return True

    last_completion = session.scalar(
        select(func.max(MonitoringEvent.occurred_at)).where(
            MonitoringEvent.event_type == "alert_completed",
            MonitoringEvent.rule_id == rule.id,
            MonitoringEvent.asset_id == asset.id,
        )
    )
    if last_completion is None:
        return True

    last_reset = session.scalar(
        select(func.max(MonitoringEvent.occurred_at)).where(
            MonitoringEvent.event_type == "condition_returned_to_normal",
            MonitoringEvent.rule_id == rule.id,
            MonitoringEvent.asset_id == asset.id,
        )
    )
    return last_reset is not None and last_reset > last_completion

def evaluate_boolean_count_threshold(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    state: RuleState | None,
    evaluated_at: datetime,
) -> RuleState:
    parameters = rule.parameters or {}

    try:
        warning_thresholds = parameters["warning_thresholds"]
        warning_1, warning_2 = warning_thresholds
        alert_threshold = parameters["alert_threshold"]

        thresholds = [warning_1, warning_2, alert_threshold]
        if any(
            not isinstance(number, int)
            or isinstance(number, bool)
            or number <= 0
            for number in thresholds
        ):
            raise ValueError("Thresholds must be positive integers")

        if not warning_1 < warning_2 < alert_threshold:
            raise ValueError("Thresholds must be strictly increasing")

    except (KeyError, TypeError, ValueError) as error:
        LOGGER.warning(
            "Invalid count thresholds for rule %s: %s",
            rule.id,
            error,
        )
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="Count threshold configuration is invalid.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="invalid_count_threshold_configuration",
        )

    counter = session.scalar(
        select(RuleCounterState)
        .where(
            RuleCounterState.rule_id == rule.id,
            RuleCounterState.asset_id == asset.id,
        )
        .with_for_update()
    )

    if counter is None:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="No rule-specific cycle counter is available.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="machine_counter_unavailable",
        )

    count = counter.cycle_count

    if count >= alert_threshold:
        stage = "alert"
        severity = "alert"
        threshold = alert_threshold
    elif count >= warning_2:
        stage = "warning_2"
        severity = "warning"
        threshold = warning_2
    elif count >= warning_1:
        stage = "warning_1"
        severity = "warning"
        threshold = warning_1
    else:
        stage = "normal"
        severity = "normal"
        threshold = None

    previous_message = state.message if state is not None else ""
    previous_stage = None

    if "[count-stage:" in previous_message:
        previous_stage = (previous_message.split("[count-stage:", 1)[1].split("]", 1)[0])

    if stage == "normal":
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="normal",
            value=count,
            message=f"Cumulative cycle count: {count}.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
        )

    messages = {
        "warning_1": f"Warning 1: cycle count reached {warning_1}.",
        "warning_2": f"Warning 2: cycle count reached {warning_2}.",
        "alert": f"Alert: cycle count reached {alert_threshold}.",
    }
    message = f"{messages[stage]} [count-stage:{stage}]"

    result = _transition_state(
        session,
        rule,
        asset,
        state,
        next_status=severity,
        value=count,
        message=message,
        evaluated_at=evaluated_at,
        condition_started_at=None,
        threshold=Decimal(threshold),
    )

    # Warning 1 and Warning 2 share the "warning" status.
    # Emit a separate event when the rule advances to Warning 2.
    if stage != previous_stage and stage == "warning_2":
        emit_event(
            session,
            event_type="warning_triggered",
            message=messages[stage],
            occurred_at=evaluated_at,
            asset_id=asset.id,
            rule_id=rule.id,
            severity="warning",
            metadata={
                "count": count,
                "threshold": warning_2,
                "stage": stage,
            },
        )

    return result

def evaluate_runtime_duration(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    state: RuleState | None,
    evaluated_at: datetime,
    stale_after_seconds: int,
) -> RuleState:
    parameters = rule.parameters or {}
    try:
        activation_at = runtime_activation_at(rule)
    except ValueError as error:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="Scheduled running-time activation is invalid.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="invalid_runtime_activation",
        )
    warnings = parameters.get("warning_thresholds_seconds")
    alert_threshold = parameters.get("alert_threshold_seconds")
    if (
        not isinstance(warnings, list)
        or len(warnings) != 2
        or not all(
            isinstance(value, (int, float, Decimal))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and value > 0
            for value in [*warnings, alert_threshold]
        )
        or not warnings[0] < warnings[1] < alert_threshold
    ):
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="Running-time threshold configuration is invalid.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="invalid_runtime_threshold_configuration",
        )

    if activation_at is not None and evaluated_at < activation_at:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="normal",
            value=0,
            message=(
                f"Scheduled runtime monitoring starts at "
                f"{activation_at.isoformat()}. [scheduled-runtime:pending]"
            ),
            evaluated_at=evaluated_at,
            condition_started_at=None,
        )

    if activation_at is not None and (
        state is None or "[scheduled-runtime:pending]" in state.message
    ):
        emit_event(
            session,
            event_type="time_rule_activated",
            message=f"Scheduled monitoring rule '{rule.name}' is now active.",
            occurred_at=evaluated_at,
            asset_id=asset.id,
            rule_id=rule.id,
            metadata={"activation_at": activation_at.isoformat()},
        )

    counter = session.scalar(
        select(RuleCounterState)
        .where(
            RuleCounterState.rule_id == rule.id,
            RuleCounterState.asset_id == asset.id,
        )
        .with_for_update()
    )
    if counter is None or counter.last_signal_at is None:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="Waiting for a trustworthy Boolean running-state signal.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="running_signal_unavailable",
        )

    stale_after = rule.stale_after_seconds or stale_after_seconds
    running_seconds = current_rule_runtime_seconds(
        counter, evaluated_at, stale_after, activation_at
    )
    if evaluated_at - counter.last_signal_at > timedelta(seconds=stale_after):
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=float(running_seconds),
            message=(
                f"Running-state signal is stale (older than {stale_after} seconds); "
                "running time is paused."
            ),
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="stale_running_signal",
        )

    if counter.is_running is None:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=float(counter.accumulated_running_seconds),
            message="Running-state signal is unknown; running time is paused.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="unknown_running_signal",
        )

    running_seconds = float(running_seconds)
    stage = (
        "alert"
        if running_seconds >= alert_threshold
        else "warning_2"
        if running_seconds >= warnings[1]
        else "warning_1"
        if running_seconds >= warnings[0]
        else "normal"
    )
    severity = "alert" if stage == "alert" else "warning" if stage.startswith("warning") else "normal"
    thresholds = {
        "warning_1": warnings[0],
        "warning_2": warnings[1],
        "alert": alert_threshold,
    }
    messages = {
        "normal": f"{'Machine running' if counter.is_running else 'Machine stopped'}. Accumulated running time: {running_seconds:.1f} seconds.",
        "warning_1": f"Running time reached the warning threshold ({warnings[0]} seconds).",
        "warning_2": f"Running time reached the higher warning threshold ({warnings[1]} seconds).",
        "alert": f"Running time reached the alert threshold ({alert_threshold} seconds).",
    }
    previous_message = state.message if state is not None else ""
    previous_stage = (
        previous_message.split("[runtime-stage:", 1)[1].split("]", 1)[0]
        if "[runtime-stage:" in previous_message
        else None
    )
    message = f"{messages[stage]} [runtime-stage:{stage}]"
    result = _transition_state(
        session,
        rule,
        asset,
        state,
        next_status=severity,
        value=running_seconds,
        message=message,
        evaluated_at=evaluated_at,
        condition_started_at=None,
        threshold=(
            Decimal(str(thresholds[stage])) if stage in thresholds else None
        ),
    )
    if stage != previous_stage and stage == "warning_2":
        emit_event(
            session,
            event_type="warning_threshold_advanced",
            message=messages[stage],
            occurred_at=evaluated_at,
            asset_id=asset.id,
            rule_id=rule.id,
            severity="warning",
            metadata={
                "running_seconds": running_seconds,
                "threshold_seconds": warnings[1],
                "stage": stage,
            },
        )
    return result


def evaluate_interval_elapsed(
    session: Session,
    rule: MonitoringRule,
    asset: Asset,
    state: RuleState | None,
    evaluated_at: datetime,
) -> RuleState:
    parameters = rule.parameters or {}
    interval_seconds = parameters.get("interval_seconds")
    if (
        not isinstance(interval_seconds, int)
        or isinstance(interval_seconds, bool)
        or interval_seconds <= 0
    ):
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="Interval rule configuration is invalid.",
            evaluated_at=evaluated_at,
            condition_started_at=None,
            error_message="invalid_interval_configuration",
        )

    anchor = (
        state.condition_started_at
        if state is not None and state.condition_started_at is not None
        else evaluated_at
    )
    elapsed_seconds = max(0, int((evaluated_at - anchor).total_seconds()))
    elapsed_periods = elapsed_seconds // interval_seconds
    previous_periods = (
        state.latest_value
        if state is not None
        and isinstance(state.latest_value, int)
        and not isinstance(state.latest_value, bool)
        else 0
    )

    if elapsed_periods == 0:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="normal",
            value=0,
            message=(
                f"Next interval is due at "
                f"{(anchor + timedelta(seconds=interval_seconds)).isoformat()}."
            ),
            evaluated_at=evaluated_at,
            condition_started_at=anchor,
        )

    if elapsed_periods > previous_periods:
        message = (
            f"Interval elapsed for rule '{rule.name}' "
            f"(period {elapsed_periods}, every {interval_seconds} seconds)."
        )
        result = _transition_state(
            session,
            rule,
            asset,
            state,
            next_status=rule.severity,
            value=elapsed_periods,
            message=message,
            evaluated_at=evaluated_at,
            condition_started_at=anchor,
            allow_new_occurrence=True,
        )
        if previous_periods > 0:
            alert = session.scalar(
                select(Alert)
                .where(
                    Alert.rule_id == rule.id,
                    Alert.target_asset_id == asset.id,
                    Alert.status == "active",
                )
                .order_by(Alert.id.desc())
                .limit(1)
            )
            if alert is not None:
                alert.acknowledged_at = None
                alert.acknowledged_by = None
                alert.last_updated_at = evaluated_at
            emit_event(
                session,
                event_type="interval_elapsed",
                message=message,
                occurred_at=evaluated_at,
                asset_id=asset.id,
                rule_id=rule.id,
                alert_id=alert.id if alert is not None else None,
                severity=rule.severity,
                metadata={
                    "interval_seconds": interval_seconds,
                    "period": elapsed_periods,
                    "missed_periods": elapsed_periods - previous_periods,
                },
            )
        return result

    if state is None:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status=rule.severity,
            value=elapsed_periods,
            message=(
                f"Interval elapsed for rule '{rule.name}' "
                f"(period {elapsed_periods}, every {interval_seconds} seconds)."
            ),
            evaluated_at=evaluated_at,
            condition_started_at=anchor,
        )

    state.last_evaluated_at = evaluated_at
    return state


def evaluate_rule(
    session: Session,
    rule: MonitoringRule,
    *,
    evaluated_at: datetime | None = None,
    stale_after_seconds: int = 300,
) -> RuleState | None:
    now = evaluated_at or utc_now()
    asset, variable = get_rule_asset(session, rule)

    if asset is None:
        return None

    state = current_state(session, rule, asset)

    if not rule.is_enabled:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=state.latest_value if state else None,
            message=(
                "Rule is disabled; existing alerts remain active until "
                "the condition is evaluated and clears."
            ),
            evaluated_at=now,
            condition_started_at=None,
        )

    if not asset.is_active:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message=("Target asset is inactive; physical operating status is not inferred."),
            evaluated_at=now,
            condition_started_at=None,
        )

    if rule.rule_type == "generic":
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="Generic rule type has no evaluator configured.",
            evaluated_at=now,
            condition_started_at=None,
        )

    if (
        rule.rule_type == "duration"
        and (rule.parameters or {}).get("condition") == "interval_elapsed"
    ):
        return evaluate_interval_elapsed(
            session,
            rule,
            asset,
            state,
            now,
        )

    if (
        variable is None
        or variable.asset_id != asset.id
        or not variable.is_active
    ):
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="Rule target variable is unavailable or inactive.",
            evaluated_at=now,
            condition_started_at=None,
            error_message="target_variable_unavailable",
        )

    if rule.rule_type == "boolean_count_threshold":
        if variable.data_type != "boolean":
            return _transition_state(
                session,
                rule,
                asset,
                state,
                next_status="unknown",
                value=None,
                message=("Boolean count threshold requires a Boolean variable."),
                evaluated_at=now,
                condition_started_at=None,
                error_message="invalid_count_variable_type",
            )

        return evaluate_boolean_count_threshold(
            session, rule, asset, state, now
        )

    if (
        rule.rule_type == "runtime_duration"
        and (rule.parameters or {}).get("warning_thresholds_seconds") is not None
    ):
        if variable.data_type != "boolean":
            return _transition_state(
                session,
                rule,
                asset,
                state,
                next_status="unknown",
                value=None,
                message="Running-time rules require a Boolean variable.",
                evaluated_at=now,
                condition_started_at=None,
                error_message="invalid_running_variable_type",
            )
        return evaluate_runtime_duration(
            session,
            rule,
            asset,
            state,
            now,
            stale_after_seconds,
        )

    reading = session.scalar(
        select(Reading)
        .where(
            Reading.asset_id == asset.id,
            Reading.variable_id == variable.id,
        )
        .order_by(Reading.recorded_at.desc(), Reading.id.desc())
        .limit(1)
    )

    if reading is None:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=None,
            message="No reading is available for the rule target.",
            evaluated_at=now,
            condition_started_at=None,
        )

    if reading.recorded_at > now + timedelta(minutes=5):
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=reading.value,
            message="Latest reading is future-dated and cannot be evaluated.",
            evaluated_at=now,
            condition_started_at=None,
            error_message="future_dated_reading",
        )

    stale_after = rule.stale_after_seconds or stale_after_seconds

    if now - reading.recorded_at > timedelta(seconds=stale_after):
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=reading.value,
            message=(f"Latest reading is stale (older than {stale_after} seconds)."),
            evaluated_at=now,
            condition_started_at=(state.condition_started_at if state else None),
            error_message="stale_reading",
        )

    if not _valid_value(variable, reading.value):
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=reading.value,
            message=("Latest reading does not match the configured variable data type."),
            evaluated_at=now,
            condition_started_at=None,
            error_message="invalid_reading_type",
        )

    try:
        holds = _condition_holds(rule, reading.value)
    except (TypeError, ValueError, ArithmeticError) as error:
        LOGGER.warning("Invalid rule configuration for rule %s: %s",
            rule.id,
            error,
        )
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="unknown",
            value=reading.value,
            message=("Rule configuration or reading is invalid; state cannot be determined."),
            evaluated_at=now,
            condition_started_at=None,
            error_message="invalid_rule_or_reading",
        )

    condition_started = state.condition_started_at if state else None

    if not holds:
        return _transition_state(
            session,
            rule,
            asset,
            state,
            next_status="normal",
            value=reading.value,
            message="Configured condition is not met.",
            evaluated_at=now,
            condition_started_at=None,
            threshold=(
                rule.threshold
                if rule.rule_type == "parameter_threshold"
                else None
            ),
        )

    duration_rule = rule.rule_type in {"runtime_duration", "duration"}

    if duration_rule:
        if condition_started is None:
            condition_started = reading.recorded_at

        duration_seconds = int((rule.parameters or {}).get("duration_seconds", 0))

        if now - condition_started < timedelta(seconds=duration_seconds):
            return _transition_state(
                session,
                rule,
                asset,
                state,
                next_status="normal",
                value=reading.value,
                message=("Condition is active but has not met its configured duration.",),
                evaluated_at=now,
                condition_started_at=condition_started,
            )

        severity = rule.severity
        message = (f"Condition remained true for at least {duration_seconds} "
            f"seconds (since {condition_started.isoformat()})."
        )
        threshold = None
    else:
        severity = rule.severity
        expected_value = (rule.parameters or {}).get("expected_value")
        if rule.rule_type == "parameter_threshold" and isinstance(expected_value, bool):
            message = (
                f"Boolean signal is {'ON' if reading.value else 'OFF'} "
                f"({rule.operator} {'ON' if expected_value else 'OFF'})."
            )
        else:
            message = (f"Rule '{rule.name}' condition met: value {reading.value} "
                f"{rule.operator} {rule.threshold}."
            )
        threshold = rule.threshold

    return _transition_state(
        session,
        rule,
        asset,
        state,
        next_status=severity,
        value=reading.value,
        message=message,
        evaluated_at=now,
        condition_started_at=condition_started,
        threshold=threshold,
    )

def evaluate_rules(
    session: Session,
    *,
    evaluated_at: datetime | None = None,
    stale_after_seconds: int = 300,
    asset_id: int | None = None,
    rule_id: int | None = None,
    respect_rule_intervals: bool = False,
) -> dict[str, int]:
    now = evaluated_at or utc_now()

    query = (
        select(MonitoringRule)
        .where(MonitoringRule.is_archived.is_(False))
        .order_by(MonitoringRule.id)
    )

    if rule_id is not None:
        query = query.where(MonitoringRule.id == rule_id)

    if asset_id is not None:
        query = query.where(
            (MonitoringRule.target_asset_id == asset_id)
            | (
                MonitoringRule.variable_id.in_(
                    select(Variable.id).where(
                        Variable.asset_id == asset_id
                    )
                )
            )
        )

    rules = session.scalars(query).all()

    counts = {
        "evaluated": 0,
        "unknown": 0,
        "normal": 0,
        "warning": 0,
        "alert": 0,
    }

    for rule in rules:
        if not rule.is_enabled:
            continue

        if (respect_rule_intervals and rule.evaluation_interval_seconds is not None):
            asset, _ = get_rule_asset(session, rule)
            state = (current_state(session, rule, asset)
                if asset is not None
                else None
            )

            if (state is not None and now - state.last_evaluated_at
                < timedelta(seconds=rule.evaluation_interval_seconds)
            ):
                continue

        state = evaluate_rule(
            session,
            rule,
            evaluated_at=now,
            stale_after_seconds=stale_after_seconds,
        )

        if state is not None:
            counts["evaluated"] += 1
            counts[state.status] += 1

    session.flush()
    return counts

def acquire_scheduler_lease(
    session: Session,
    *,
    owner_id: str,
    now: datetime,
    lease_seconds: int,
    name: str = "monitoring-evaluation",
) -> bool:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("Scheduler lease timestamps must be timezone-aware.")
    if lease_seconds < 1:
        raise ValueError("Scheduler lease duration must be at least one second.")
    now = now.astimezone(timezone.utc)
    lease_until = now + timedelta(seconds=lease_seconds)

    claimed = session.execute(
        update(SchedulerLease)
        .where(
            SchedulerLease.name == name,
            (SchedulerLease.owner_id == owner_id)
            | (SchedulerLease.lease_until <= now),
        )
        .values(
            owner_id=owner_id,
            lease_until=lease_until,
            updated_at=now,
        )
    )

    if claimed.rowcount:
        session.commit()
        return True

    if session.get(SchedulerLease, name) is not None:
        session.rollback()
        return False

    session.add(
        SchedulerLease(
            name=name,
            owner_id=owner_id,
            lease_until=lease_until,
            updated_at=now,
        )
    )

    try:
        session.commit()
        return True
    except IntegrityError:
        session.rollback()
        return False


def evaluate_reading_rules(
    session: Session,
    *,
    asset_id: int,
    variable_id: int,
    evaluated_at: datetime | None = None,
    stale_after_seconds: int = 300,
) -> dict[str, int]:
    rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.is_enabled.is_(True),
            MonitoringRule.is_archived.is_(False),
            MonitoringRule.variable_id == variable_id,
        )
        .order_by(MonitoringRule.id)
    ).all()

    matching = [
        rule
        for rule in rules
        if rule.target_asset_id in (None, asset_id)
    ]

    counts = {
        "evaluated": 0,
        "unknown": 0,
        "normal": 0,
        "warning": 0,
        "alert": 0,
    }

    for rule in matching:
        state = evaluate_rule(
            session,
            rule,
            evaluated_at=evaluated_at,
            stale_after_seconds=stale_after_seconds,
        )

        if state is not None:
            counts["evaluated"] += 1
            counts[state.status] += 1

    session.flush()
    return counts


def set_rule_enabled_state(
    session: Session,
    rule: MonitoringRule,
    enabled: bool,
    *,
    at: datetime | None = None,
) -> None:
    if rule.is_enabled == enabled:
        return

    now = at or utc_now()
    rule.is_enabled = enabled
    if rule.lifecycle_status != "completed":
        rule.lifecycle_status = "in_progress" if enabled else "deactivated"
    asset, _ = get_rule_asset(session, rule)

    if rule.rule_type == "runtime_duration":
        counter = session.scalar(
            select(RuleCounterState)
            .where(
                RuleCounterState.rule_id == rule.id,
                RuleCounterState.asset_id == rule.target_asset_id,
            )
            .with_for_update()
        )
        if counter is not None:
            if not enabled:
                advance_rule_runtime(
                    counter,
                    now,
                    rule.stale_after_seconds or 300,
                )
            counter.is_running = None
            counter.last_signal_at = None
            counter.runtime_checkpoint_at = None
            counter.updated_at = now

    if asset is not None:
        state = current_state(session, rule, asset)

        if not enabled:
            _transition_state(
                session,
                rule,
                asset,
                state,
                next_status="unknown",
                value=state.latest_value if state else None,
                message="Rule disabled; its active alert has been closed.",
                evaluated_at=now,
                condition_started_at=None,
            )

    resolve_active_rule_alerts(session, rule.id, now)

    emit_event(
        session,
        event_type="rule_enabled" if enabled else "rule_disabled",
        message=(
            f"Rule '{rule.name}' "
            f"{'enabled' if enabled else 'disabled'}."
        ),
        occurred_at=now,
        asset_id=asset.id if asset else None,
        rule_id=rule.id,
    )


def resolve_active_rule_alerts(
    session: Session,
    rule_id: int,
    at: datetime | None = None,
) -> None:
    now = at or utc_now()
    active_alerts = session.scalars(
        select(Alert).where(
            Alert.rule_id == rule_id,
            Alert.status == "active",
        )
    ).all()
    for alert in active_alerts:
        alert.status = "resolved"
        alert.resolved_at = now
        alert.last_updated_at = now
