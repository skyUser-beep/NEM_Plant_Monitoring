# create,view,update and filter machine monitoring rules
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from asyncua import ua
from asyncua.ua.uaerrors import UaStringParsingError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Asset, Alert, MonitoringRule, RuleState, Variable
from app.schemas.rule import RuleCreate, RuleRead, RuleUpdate
from app.services.monitoring_engine import emit_event, set_rule_enabled_state
from app.services.monitoring_engine import utc_now

router = APIRouter(prefix="/rules", tags=["monitoring rules"])


def is_mapping_bypass_enabled(request: Request) -> bool:
    settings = getattr(request.app.state, "settings", None)
    return bool(getattr(settings, "opc_ua_mapping_bypass_enabled", False))


#Configured PLC cycle signal
def configured_cycle_signal_mapping(request: Request,variable_id: int | None,) -> tuple[int, int] | None:
    collector = request.app.state.opcua_collector
    return next(
        (
            (mapping.asset_id, mapping.cycle_signal.variable_id)
            for mapping in collector.mappings
            if mapping.cycle_signal is not None
            and mapping.cycle_signal.variable_id == variable_id
        ),
        None,
    )


def configured_runtime_signal_mapping(
    request: Request,
    variable_id: int | None,
) -> tuple[int, int] | None:
    collector = request.app.state.opcua_collector
    return next(
        (
            (mapping.asset_id, mapping.running_signal.variable_id)
            for mapping in collector.mappings
            if mapping.running_signal is not None
            and mapping.running_signal.variable_id == variable_id
        ),
        None,
    )


#Find the rule safely
def rule_or_404(session: Session, rule_id: int) -> MonitoringRule:
    rule = session.get(MonitoringRule, rule_id)
    if rule is None or rule.is_archived:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    return rule

# make sure a rule refers to valid machine assets and variables, and its configuration makes sense
def validate_targets(
    session: Session,
    target_asset_id: int | None,
    variable_id: int | None,
    rule_type: str,
    operator: str | None,
    threshold,
    parameters: dict | None,
    cycle_signal_mapping: tuple[int, int] | None,
    runtime_signal_mapping: tuple[int, int] | None = None,
    mapping_bypass_enabled: bool = False,
) -> None:
    #Check that asset exits
    asset = session.get(Asset, target_asset_id) if target_asset_id is not None else None
    if target_asset_id is not None and asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {target_asset_id} was not found")
    #Varibale exists
    variable = session.get(Variable, variable_id) if variable_id is not None else None
    if variable_id is not None and variable is None:
        raise HTTPException(status_code=404, detail=f"Variable {variable_id} was not found")
    if variable is not None and target_asset_id is not None:
        if variable.asset_id != target_asset_id:
            raise HTTPException(
                status_code=422, detail="Target variable does not belong to target asset"
            )
    if rule_type == "parameter_threshold":
        expected_value = (parameters or {}).get("expected_value")
        if isinstance(expected_value, bool):
            if (
                variable is None
                or not variable.is_active
                or variable.data_type != "boolean"
                or operator not in {"==", "!=", "eq", "ne"}
                or threshold is not None
            ):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Boolean parameter thresholds require an active Boolean "
                        "variable, an equality operator, and a Boolean expected_value"
                    ),
                )
        else:
            if variable is None or variable.data_type not in {"number", "integer"}:
                raise HTTPException(status_code=422,detail="Parameter threshold rules require a numeric variable",)
            if operator is None or threshold is None:
                raise HTTPException(status_code=422, detail="Parameter threshold rules require an operator and threshold",)
    if rule_type in {"runtime_duration", "duration"}:
        interval_elapsed = (
            rule_type == "duration"
            and parameters is not None
            and parameters.get("condition") == "interval_elapsed"
        )
        if interval_elapsed:
            interval_seconds = parameters.get("interval_seconds")
            if (
                asset is None
                or not isinstance(interval_seconds, int)
                or isinstance(interval_seconds, bool)
                or interval_seconds <= 0
                or variable_id is not None
            ):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Interval-based rules require an asset target, a positive "
                        "interval_seconds value, and no variable target"
                    ),
                )
            return
        duration = parameters.get("duration_seconds") if parameters else None
        if rule_type == "runtime_duration" and parameters and (
            "warning_thresholds_seconds" in parameters
        ):
            if (
                asset is None
                or not asset.is_active
                or variable is None
                or not variable.is_active
                or variable.data_type != "boolean"
            ):
                raise HTTPException(status_code=422,detail="Running-time rules require an active Boolean variable on an active asset",)
            bypass_signal_is_valid = (
                mapping_bypass_enabled
                and variable is not None
                and variable.opcua_node_id is not None
                and variable.signal_role in {None, "running"}
            )
            if bypass_signal_is_valid:
                try:
                    ua.NodeId.from_string(variable.opcua_node_id)
                except (TypeError, ValueError, UaStringParsingError) as error:
                    raise HTTPException(status_code=422,detail="Running-time rules require a valid OPC UA NodeId",) from error
            if (
                runtime_signal_mapping != (target_asset_id, variable_id)
                and not bypass_signal_is_valid
            ):
                raise HTTPException(
                    status_code=422,
                    detail=("Running-time rules must target this asset's configured "
                        "OPC UA running signal or an asset-owned declared Boolean "
                        "running signal while mapping bypass is enabled"
                    ),
                )
        else:
            if (
                not isinstance(duration, int)
                or isinstance(duration, bool)
                or duration <= 0
            ):
                raise HTTPException(status_code=422,detail="Runtime rules require a positive parameters.duration_seconds",)
            if rule_type == "duration":
                condition = (parameters or {}).get("condition", "equals")
                expected = (parameters or {}).get("expected_value")
                if condition == "threshold":
                    if variable is None or variable.data_type not in {"number", "integer"}:
                        raise HTTPException(status_code=422, detail="Threshold duration rules require a numeric variable.",)
                elif isinstance(expected, bool):
                    if (
                        asset is None
                        or not asset.is_active
                        or variable is None
                        or not variable.is_active
                        or variable.data_type != "boolean"
                    ):
                        raise HTTPException( status_code=422, detail="Boolean duration rules require an active Boolean variable on an active asset.",)
                    bypass_signal_is_valid = (
                        mapping_bypass_enabled
                        and variable.opcua_node_id is not None
                        and variable.signal_role == "running"
                    )
                    if bypass_signal_is_valid:
                        try:
                            ua.NodeId.from_string(variable.opcua_node_id)
                        except (TypeError, ValueError, UaStringParsingError) as error:
                            raise HTTPException(status_code=422,detail="Boolean duration rules require a valid OPC UA NodeId.",) from error
                    if (
                        runtime_signal_mapping != (target_asset_id, variable_id)
                        and not bypass_signal_is_valid
                    ):
                        raise HTTPException(status_code=422,
                            detail=(
                                "Boolean duration rules must target this asset's "
                                "configured running signal or a declared variable "
                                "marked as Machine running state."
                            ),
                        )
    if rule_type == "boolean_count_threshold":
        if (
            asset is None
            or not asset.is_active
            or variable is None
            or not variable.is_active
            or variable.data_type != "boolean"
        ):
            raise HTTPException(status_code=422,detail=("Boolean count threshold rules require an active Boolean variable"),)
        bypass_signal_is_valid = (
            mapping_bypass_enabled
            and variable is not None
            and variable.opcua_node_id is not None
            and variable.signal_role in {None, "cycle"}
        )
        if bypass_signal_is_valid:
            try:
                ua.NodeId.from_string(variable.opcua_node_id)
            except (TypeError, ValueError, UaStringParsingError) as error:
                raise HTTPException(status_code=422,detail="Boolean count threshold rules require a valid OPC UA NodeId",) from error
        if (
            cycle_signal_mapping != (target_asset_id, variable_id)
            and not bypass_signal_is_valid
        ):
            raise HTTPException(status_code=422,detail=("Boolean count threshold rules must target the active Boolean "
                    "variable configured as this asset's OPC UA cycle signal, or "
                    "an asset-owned declared Boolean variable while mapping bypass is enabled."
                ),
            )
        parameters = parameters or {}
        warning_thresholds = parameters.get("warning_thresholds")
        alert_threshold = parameters.get("alert_threshold")

        if (
            not isinstance(warning_thresholds, list)
            or len(warning_thresholds) != 2
            or any(
                not isinstance(value, int)
                or isinstance(value, bool)
                or value <= 0
                for value in warning_thresholds
            )
            or warning_thresholds[0] >= warning_thresholds[1]
            or not isinstance(alert_threshold, int)
            or isinstance(alert_threshold, bool)
            or alert_threshold <= warning_thresholds[1]
        ):
            raise HTTPException(status_code=422,detail=("Configure two increasing positive warning thresholds and a larger positive alert threshold"),)

# Create a new rule
@router.post("", response_model=RuleRead, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: RuleCreate,
    request: Request,
    session: Session = Depends(get_db),
) -> MonitoringRule:
    # Validate the target
    validate_targets(
        session, payload.target_asset_id, payload.variable_id, payload.rule_type,
        payload.operator, payload.threshold, payload.parameters,
        configured_cycle_signal_mapping(request, payload.variable_id),
        configured_runtime_signal_mapping(request, payload.variable_id),
        is_mapping_bypass_enabled(request),
    )
    rule_data = payload.model_dump()
    rule_data["lifecycle_status"] = ("in_progress" if payload.is_enabled else "deactivated")
    rule = MonitoringRule(**rule_data)
    session.add(rule)
    session.flush()

    emit_event(
        session,
        event_type="rule_created",
        message=f"Rule '{rule.name}' created.",
        occurred_at=utc_now(),
        asset_id=rule.target_asset_id,
        rule_id=rule.id,
    )
    session.commit()
    session.refresh(rule)
    return rule

#list and filter rules
@router.get("")
def list_rules(
    target_asset_id: int | None = Query(default=None, gt=0),
    rule_type: str | None = None,
    severity: str | None = None,
    is_enabled: bool | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    session: Session = Depends(get_db),
) -> dict[str, object]:
    #Build the database queries
    query = select(MonitoringRule).where(
        MonitoringRule.is_archived.is_(False),
        MonitoringRule.target_asset_id.is_not(None),
    )
    count_query = (
        select(func.count())
        .select_from(MonitoringRule)
        .where(
            MonitoringRule.is_archived.is_(False),
            MonitoringRule.target_asset_id.is_not(None),
        )
    )
    for condition, column in (
        (target_asset_id, MonitoringRule.target_asset_id),
        (rule_type, MonitoringRule.rule_type),
        (severity, MonitoringRule.severity),
        (is_enabled, MonitoringRule.is_enabled),
    ):
        if condition is not None:
            query, count_query = query.where(column == condition), count_query.where(
                column == condition
            )
    items = session.scalars(query.order_by(MonitoringRule.id).offset(offset).limit(limit)).all()
    return {
        "items": [RuleRead.model_validate(item) for item in items],
        "total": session.scalar(count_query) or 0,
        "limit": limit,
        "offset": offset,
    }

# retrieve one rule
@router.get("/{rule_id}", response_model=RuleRead)
def get_rule(rule_id: int, session: Session = Depends(get_db)) -> MonitoringRule:
    return rule_or_404(session, rule_id)

#Update a rule
@router.patch("/{rule_id}", response_model=RuleRead)
def update_rule(
    rule_id: int,
    payload: RuleUpdate,
    request: Request,
    session: Session = Depends(get_db),
) -> MonitoringRule:
    rule = rule_or_404(session, rule_id)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="Provide at least one field to update")
    if rule.lifecycle_status == "completed" and changes.get("is_enabled") is True:
        raise HTTPException(status_code=409,detail="Completed rules cannot be reactivated. Create a new rule instead.",)
    prospective = {
        key: changes.get(key, getattr(rule, key))
        for key in (
            "name", "rule_type", "target_asset_id", "variable_id", "operator",
            "threshold", "parameters", "severity", "is_enabled",
            "evaluation_interval_seconds", "stale_after_seconds",
        )
    }
    validated = RuleCreate.model_validate(prospective)
    validate_targets(
        session, validated.target_asset_id, validated.variable_id, validated.rule_type,
        validated.operator, validated.threshold, validated.parameters,
        configured_cycle_signal_mapping(request, validated.variable_id),
        configured_runtime_signal_mapping(request, validated.variable_id),
        is_mapping_bypass_enabled(request),
    )
    # prevent changing targets after evaluation state exits
    target_fields = {"target_asset_id", "variable_id"}
    #Prevent changing targets while alerts are active
    if target_fields.intersection(changes) and session.scalar(
        select(RuleState.id).where(RuleState.rule_id == rule.id).limit(1)
    ):
        raise HTTPException(status_code=409,detail="A rule target cannot be changed after evaluation state exists",)
    if target_fields.intersection(changes) and session.scalar(
        select(Alert.id).where(Alert.rule_id == rule.id, Alert.status == "active").limit(1)
    ):
        raise HTTPException(status_code=409,detail="Resolve active alerts before changing a rule target",)
    #Apply the changes
    for field, value in changes.items():
        if field != "is_enabled":
            setattr(rule, field, value)
    if "is_enabled" in changes:
        set_rule_enabled_state(session, rule, changes["is_enabled"])
    session.commit()
    session.refresh(rule)
    return rule