#FastApi router that connects your react frontend to your backend and postgreSQL database

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from typing import Any

from cryptography.fernet import Fernet # encrypts and decrypts sensitive values, such as a saved email password
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError, field_validator 
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError # Handles database constraint failures,such as duplicate collection name
from sqlalchemy.orm import Session 

from app.db.session import get_db
from app.models import (
    Alert,
    Asset,
    BackupRecord,
    FrontendConfig,
    InstructionDocument,
    InstructionDocumentFile,
    MaintenanceRecord,
    MonitoringEvent,
    MonitoringRule,
    Reading,
    RuleCollection,
    RuleState,
    Variable,
)
from app.schemas.rule import (
    RuleCopyRequest,
    RuleCreate,
    RuleRead,
    RuleSelection,
    UsageRuleCreate,
)
from app.services.frontend_backup import create_backup, restore_backup
from app.services.monitoring_engine import (emit_event,resolve_active_rule_alerts,set_rule_enabled_state,)
from app.api.routes.rules import configured_cycle_signal_mapping, validate_targets
from app.api.routes.monitoring import state_for_rule

router = APIRouter(tags=["frontend compatibility"])

UPLOAD_DIR = Path(__file__).resolve().parents[3] / "uploads" / "instruction_documents"

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_UPLOAD_BYTES = 24 * 1024 * 1024
MAX_FILES_PER_DOCUMENT = 10

ALLOWED_DOCUMENT_EXTENSIONS = {".pdf", ".doc", ".docx", ".txt"}

class ProfileUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=50)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Name cannot be empty")
        return value

#Validate a rule collection`s name and description.
class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Collection name cannot be empty")
        return value

#Validate an instruction document`s title and type
class DocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    kind: str = Field(min_length=1, max_length=50)
    description: str | None = None

    @field_validator("title", "kind")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value

#Accepts an optional backup name and note
class BackupCreate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    note: str | None = None

#Validates a maintenance log entry
class LogbookEntry(BaseModel):
    text: str = Field(min_length=1, max_length=4000)

    @field_validator("text")
    @classmethod
    def strip_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Logbook entry cannot be empty")
        return value

    
class InstructionCreate(BaseModel):
    name: str = Field(min_length=2, max_length=50)
    labels: list[str] = Field(default_factory=list, max_length=10)
    duration_minutes: int = Field(default=30, ge=1)
    text: str = Field(min_length=1, max_length=10000)

    @field_validator("name", "text")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value

    @field_validator("labels")
    @classmethod
    def validate_labels(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(len(value) < 2 or len(value) > 50 for value in cleaned):
            raise ValueError("Each label must contain 2 to 50 characters")
        if len(set(cleaned)) != len(cleaned):
            raise ValueError("Labels must be unique")
        return cleaned
#All the above classes are use to make sure invalid data is rejected before it reaches the database, and to provide clear error messages to the frontend.

#Retrieves a saved configuration record
def _config(session: Session, key: str) -> dict[str, Any]:
    record = session.get(FrontendConfig, key)
    return dict(record.value) if record is not None else {}

#implements an insert-or-update pattern
def _save_config(session: Session, key: str, value: dict[str, Any]) -> None:
    record = session.get(FrontendConfig, key)
    if record is None:
        session.add(FrontendConfig(key=key, value=value))
    else:
        record.value = value
    session.commit()

#converts a MonitoringRule db object into py dict that fastapi can return as JSON to the frontend
def _rule_row(session: Session, rule: MonitoringRule) -> dict[str, Any]:
    state = state_for_rule(session, rule)
    asset = session.get(Asset, rule.target_asset_id) if rule.target_asset_id else None
    return {
        "id": rule.id,
        "name": rule.name,
        "description": rule.description,
        "asset_id": rule.target_asset_id,
        "asset_name": asset.name if asset else "",
        "severity": rule.severity,
        "state": "activated" if rule.is_enabled else "not_activated",
        "is_enabled": rule.is_enabled,
        "status": (
            {"normal": "ok"}.get(state.status, state.status)
            if rule.is_enabled
            else "unknown"
        ),
        "rule_type": rule.rule_type,
        "variable_id": rule.variable_id,
        "operator": rule.operator,
        "threshold": float(rule.threshold) if rule.threshold is not None else None,
        "parameters": rule.parameters,
    }

# Finds an asset and all its descendants, returning a set of their IDs. This is used to retrieve all rules for an asset and its children.
def _descendant_ids(session: Session, asset_id: int) -> set[int]:
    result = {asset_id}
    frontier = [asset_id]
    while frontier:
        children = session.scalars(
            select(Asset.id).where(Asset.parent_asset_id.in_(frontier))
        ).all()
        frontier = [item for item in children if item not in result]
        result.update(frontier)
    return result

#Encrypting saved email passwords
def _fernet(request: Request) -> Fernet:
    value = request.app.state.settings.settings_encryption_key.get_secret_value().strip()
    if not value:
        raise HTTPException( status_code=503,detail="Email password encryption is not configured; set SETTINGS_ENCRYPTION_KEY in the backend environment.",)
    try:
        return Fernet(value.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise HTTPException(status_code=503, detail="SETTINGS_ENCRYPTION_KEY must be a valid Fernet key.") from error

#Dashboard summary endpoint
@router.get("/summary")
def frontend_summary(session: Session = Depends(get_db)) -> dict[str, Any]:
    from app.api.routes.dashboard import dashboard_summary

    summary = dashboard_summary(session)
    return {
        "rules_alert": summary.rules_alert,
        "rules_warning": summary.rules_warning,
        "assets_alert": summary.assets_in_alert_state,
        "assets_warning": summary.assets_in_warning_state,
        "monitored_assets": summary.monitored_assets,
        "total_assets": summary.total_assets,
        "stats": {
            "activated": summary.enabled_rules,
            "suspended": 0,
            "finished": 0,
            "not_activated": summary.disabled_rules,
        },
    }

#Reading and filtering machine rules
#Rules by status
@router.get("/rules/status/{kind}")
def frontend_rules_by_status(kind: str, session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    if kind not in {"alert", "warning"}:
        raise HTTPException(status_code=422, detail="Rule status must be alert or warning")
    rows = session.scalars(
        select(MonitoringRule)
        .where(MonitoringRule.is_archived.is_(False))
        .order_by(MonitoringRule.id)
    ).all()
    return [
        row
        for row in (_rule_row(session, rule) for rule in rows)
        if row["status"] == kind
    ]

# rule for a specific asset
@router.get("/assets/{asset_id}/rules")
def frontend_asset_rules(asset_id: int,include_children: bool = False,session: Session = Depends(get_db),) -> list[dict[str, Any]]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    asset_ids = _descendant_ids(session, asset_id) if include_children else {asset_id}
    rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.target_asset_id.in_(asset_ids),
            MonitoringRule.is_archived.is_(False),
        )
        .order_by(MonitoringRule.id)
    ).all()
    return [_rule_row(session, rule) for rule in rules]


def _mapped_variable(
    session: Session,
    source_variable_id: int | None,
    target_asset_id: int,
) -> Variable | None:
    if source_variable_id is None:
        return None
    source = session.get(Variable, source_variable_id)
    if source is None:
        raise HTTPException(status_code=422, detail="The source rule variable no longer exists")
    matches = session.scalars(
        select(Variable).where(
            Variable.asset_id == target_asset_id,
            Variable.is_active.is_(True),
            func.lower(Variable.key) == source.key.lower(),
            Variable.data_type == source.data_type,
        )
    ).all()
    if len(matches) != 1:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Rule variable '{source.key}' must have exactly one active "
                "variable with the same key and data type on the target asset"
            ),
        )
    return matches[0]


def _rule_definition(
    source: MonitoringRule,
    target_asset_id: int,
    variable: Variable | None,
) -> dict[str, Any]:
    return {
        "name": source.name,
        "description": source.description,
        "rule_type": source.rule_type,
        "target_asset_id": target_asset_id,
        "variable_id": variable.id if variable else None,
        "operator": source.operator,
        "threshold": source.threshold,
        "parameters": source.parameters,
        "severity": source.severity,
        "is_enabled": False,
        "evaluation_interval_seconds": source.evaluation_interval_seconds,
        "stale_after_seconds": source.stale_after_seconds,
    }


def _same_rule_definition(rule: MonitoringRule, definition: dict[str, Any]) -> bool:
    return all(
        getattr(rule, field) == definition[field]
        for field in (
            "name",
            "description",
            "rule_type",
            "target_asset_id",
            "variable_id",
            "operator",
            "threshold",
            "parameters",
            "severity",
        )
    )


@router.get("/assets/{asset_id}/rules/predefined")
def frontend_predefined_rules(
    asset_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    templates = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.target_asset_id.is_(None),
            MonitoringRule.is_archived.is_(False),
        )
        .order_by(MonitoringRule.id)
    ).all()
    assigned = session.scalars(
        select(MonitoringRule).where(
            MonitoringRule.target_asset_id == asset_id,
            MonitoringRule.is_archived.is_(False),
        )
    ).all()
    result = []
    for template in templates:
        reason = None
        mapped = None
        try:
            if template.rule_type == "generic":
                raise HTTPException(
                    status_code=422,
                    detail="This rule type has no monitoring evaluator",
                )
            mapped = _mapped_variable(session, template.variable_id, asset_id)
            definition = _rule_definition(template, asset_id, mapped)
            try:
                validated = RuleCreate.model_validate(definition)
            except ValidationError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
            validate_targets(
                session,
                validated.target_asset_id,
                validated.variable_id,
                validated.rule_type,
                validated.operator,
                validated.threshold,
                validated.parameters,
                configured_cycle_signal_mapping(request, validated.variable_id),
            )
        except HTTPException as error:
            reason = str(error.detail)
            definition = None
        except ValidationError as error:
            reason = str(error)
            definition = None
        duplicate = bool(
            definition
            and any(_same_rule_definition(rule, definition) for rule in assigned)
        )
        result.append(
            {
                **RuleRead.model_validate(template).model_dump(mode="json"),
                "assigned": duplicate,
                "unavailable_reason": reason,
                "mapped_variable_name": mapped.name if mapped else None,
            }
        )
    return result


@router.post("/assets/{asset_id}/rules/assign", status_code=201)
def frontend_assign_predefined_rules(
    asset_id: int,
    payload: RuleSelection,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    templates = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.id.in_(payload.rule_ids),
            MonitoringRule.target_asset_id.is_(None),
            MonitoringRule.is_archived.is_(False),
        )
        .order_by(MonitoringRule.id)
        .with_for_update()
    ).all()
    if len(templates) != len(payload.rule_ids):
        raise HTTPException(
            status_code=404,
            detail="One or more selected predefined rules are unavailable",
        )
    existing = session.scalars(
        select(MonitoringRule).where(
            MonitoringRule.target_asset_id == asset_id,
            MonitoringRule.is_archived.is_(False),
        )
    ).all()
    prepared: list[tuple[MonitoringRule, dict[str, Any]]] = []
    already_assigned = []
    for template in templates:
        if template.rule_type == "generic":
            raise HTTPException(
                status_code=422,
                detail=f"Rule '{template.name}' has no monitoring evaluator",
            )
        mapped = _mapped_variable(session, template.variable_id, asset_id)
        definition = _rule_definition(template, asset_id, mapped)
        try:
            validated = RuleCreate.model_validate(definition)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        validate_targets(
            session,
            validated.target_asset_id,
            validated.variable_id,
            validated.rule_type,
            validated.operator,
            validated.threshold,
            validated.parameters,
            configured_cycle_signal_mapping(request, validated.variable_id),
        )
        if any(_same_rule_definition(rule, definition) for rule in existing):
            already_assigned.append(template.id)
            continue
        prepared.append((template, definition))
        existing.append(MonitoringRule(**definition))

    created = []
    for template, definition in prepared:
        rule = MonitoringRule(**definition)
        session.add(rule)
        session.flush()
        emit_event(
            session,
            event_type="rule_created",
            message=f"Rule '{rule.name}' assigned to asset {asset_id}.",
            occurred_at=datetime.now(timezone.utc),
            asset_id=asset_id,
            rule_id=rule.id,
        )
        created.append({"template_rule_id": template.id, "id": rule.id, "name": rule.name})
    session.commit()
    return {"created": created, "already_assigned": already_assigned}


@router.post("/assets/{asset_id}/rules/copy", status_code=201)
def frontend_copy_asset_rules(
    asset_id: int,
    payload: RuleCopyRequest,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    if payload.source_asset_id == asset_id:
        raise HTTPException(status_code=422, detail="Source and target assets must be different")
    if session.get(Asset, payload.source_asset_id) is None:
        raise HTTPException(
            status_code=404,
            detail=f"Source asset {payload.source_asset_id} was not found",
        )
    source_rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.id.in_(payload.rule_ids),
            MonitoringRule.target_asset_id == payload.source_asset_id,
            MonitoringRule.is_archived.is_(False),
        )
        .order_by(MonitoringRule.id)
        .with_for_update()
    ).all()
    if len(source_rules) != len(payload.rule_ids):
        raise HTTPException(
            status_code=404,
            detail="One or more selected source rules are unavailable",
        )
    selected = [
        rule
        for rule in source_rules
        if payload.include_disabled or rule.is_enabled
    ]
    existing = session.scalars(
        select(MonitoringRule).where(
            MonitoringRule.target_asset_id == asset_id,
            MonitoringRule.is_archived.is_(False),
        )
    ).all()
    prepared = []
    already_copied = []
    for source in selected:
        if source.rule_type == "generic":
            raise HTTPException(
                status_code=422,
                detail=f"Rule '{source.name}' has no monitoring evaluator and cannot be copied",
            )
        mapped = _mapped_variable(session, source.variable_id, asset_id)
        definition = _rule_definition(source, asset_id, mapped)
        try:
            validated = RuleCreate.model_validate(definition)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        validate_targets(
            session,
            validated.target_asset_id,
            validated.variable_id,
            validated.rule_type,
            validated.operator,
            validated.threshold,
            validated.parameters,
            configured_cycle_signal_mapping(request, validated.variable_id),
        )
        if any(_same_rule_definition(rule, definition) for rule in existing):
            already_copied.append(source.id)
            continue
        prepared.append((source, definition))
        existing.append(MonitoringRule(**definition))

    created = []
    for source, definition in prepared:
        rule = MonitoringRule(**definition)
        session.add(rule)
        session.flush()
        emit_event(
            session,
            event_type="rule_created",
            message=f"Rule '{rule.name}' copied from asset {payload.source_asset_id}.",
            occurred_at=datetime.now(timezone.utc),
            asset_id=asset_id,
            rule_id=rule.id,
        )
        created.append({"source_rule_id": source.id, "id": rule.id, "name": rule.name})
    session.commit()
    return {
        "created": created,
        "already_copied": already_copied,
        "excluded_disabled": len(source_rules) - len(selected),
    }

#Creating a new rules for a specific asset
@router.post("/assets/{asset_id}/rules", status_code=201)
def frontend_create_asset_rule(
    asset_id: int,
    payload: RuleCreate,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    if payload.target_asset_id != asset_id:
        raise HTTPException(status_code=422, detail="Rule target_asset_id must match the URL asset")
    validate_targets(
        session, payload.target_asset_id, payload.variable_id, payload.rule_type,
        payload.operator, payload.threshold, payload.parameters,
        configured_cycle_signal_mapping(request, payload.variable_id),
    )
    rule = MonitoringRule(**payload.model_dump())
    session.add(rule)
    session.flush()
    emit_event(
        session,
        event_type="rule_created",
        message=f"Rule '{rule.name}' created.",
        occurred_at=datetime.now(timezone.utc),
        asset_id=rule.target_asset_id,
        rule_id=rule.id,
    )
    session.commit()
    session.refresh(rule)
    return _rule_row(session, rule)


@router.post("/assets/{asset_id}/rules/usage", status_code=201)
def frontend_create_usage_rule(
    asset_id: int,
    payload: UsageRuleCreate,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")

    variable = session.get(Variable, payload.variable_id)
    if variable is None:
        raise HTTPException(status_code=404, detail=f"Variable {payload.variable_id} was not found")
    if not variable.is_active:
        raise HTTPException(status_code=422, detail="Usage thresholds require an active numeric variable")
    rule_payload = RuleCreate(
        name=payload.name,
        description=payload.description,
        rule_type="parameter_threshold",
        target_asset_id=asset_id,
        variable_id=payload.variable_id,
        operator=">=",
        threshold=payload.usage_limit,
        severity=payload.severity,
        is_enabled=True,
    )
    validate_targets(
        session,
        rule_payload.target_asset_id,
        rule_payload.variable_id,
        rule_payload.rule_type,
        rule_payload.operator,
        rule_payload.threshold,
        rule_payload.parameters,
        configured_cycle_signal_mapping(request, rule_payload.variable_id),
    )
    rule = MonitoringRule(**rule_payload.model_dump())
    session.add(rule)
    session.flush()
    emit_event(
        session,
        event_type="rule_created",
        message=f"Usage threshold rule '{rule.name}' created.",
        occurred_at=datetime.now(timezone.utc),
        asset_id=asset_id,
        rule_id=rule.id,
    )
    session.commit()
    session.refresh(rule)
    return _rule_row(session, rule)


@router.post("/assets/{asset_id}/rules/time", status_code=410)
def frontend_create_time_rule(
    asset_id: int,
    session: Session = Depends(get_db),
) -> None:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    raise HTTPException(
        status_code=410,
        detail=(
            "Time-based maintenance is not a monitoring rule. Create a planned "
            "maintenance record through POST /maintenance instead."
        ),
    )


@router.post("/assets/{asset_id}/rules/bulk")
def frontend_bulk_rule_state(
    asset_id: int,
    payload: dict[str, str],
    request: Request,
    include_children: bool = False,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    state = payload.get("state")
    if state not in {"activated", "not_activated"}:
        raise HTTPException(status_code=422, detail="State must be activated or not_activated")
    asset_ids = _descendant_ids(session, asset_id) if include_children else {asset_id}
    rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.target_asset_id.in_(asset_ids),
            MonitoringRule.is_archived.is_(False),
        )
        .order_by(MonitoringRule.id)
        .with_for_update()
    ).all()
    enabled = state == "activated"
    updated = []
    skipped = []
    for rule in rules:
        if rule.is_enabled == enabled:
            continue
        if enabled:
            try:
                if rule.rule_type == "generic":
                    raise HTTPException(
                        status_code=422,
                        detail="This rule type has no monitoring evaluator",
                    )
                validate_targets(
                    session,
                    rule.target_asset_id,
                    rule.variable_id,
                    rule.rule_type,
                    rule.operator,
                    rule.threshold,
                    rule.parameters,
                    configured_cycle_signal_mapping(request, rule.variable_id),
                )
            except HTTPException as error:
                skipped.append({"rule_id": rule.id, "name": rule.name, "reason": str(error.detail)})
                continue
            set_rule_enabled_state(session, rule, enabled)
        else:
            set_rule_enabled_state(session, rule, enabled)
        updated.append(rule.id)
    session.commit()
    return {"updated": len(updated), "updated_rule_ids": updated, "skipped": skipped}

#Deleting a rule(Soft deletion,also called archiving rather than deleting the db row)
@router.delete("/rules/{rule_id}", status_code=204)
def frontend_delete_rule(rule_id: int, session: Session = Depends(get_db)) -> None:
    rule = session.get(MonitoringRule, rule_id)
    if rule is None or rule.is_archived:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    if rule.is_enabled:
        raise HTTPException(
            status_code=409, detail="Deactivate the rule before archiving it."
        )
    set_rule_enabled_state(session, rule, False)
    resolve_active_rule_alerts(session, rule.id)
    rule.is_archived = True
    emit_event(
        session,
        event_type="rule_archived",
        message=f"Rule '{rule.name}' archived; evaluation and alert history retained.",
        occurred_at=datetime.now(timezone.utc),
        asset_id=rule.target_asset_id,
        rule_id=rule.id,
    )
    session.commit()


@router.delete("/rules/{rule_id}/permanent", status_code=204)
def frontend_hard_delete_rule(
    rule_id: int,
    session: Session = Depends(get_db),
) -> None:
    rule = session.scalar(
        select(MonitoringRule)
        .where(MonitoringRule.id == rule_id)
        .with_for_update()
    )
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    if rule.is_enabled:
        raise HTTPException(
            status_code=409,
            detail="Deactivate the rule before permanently deleting it.",
        )

    alert_ids = session.scalars(
        select(Alert.id).where(Alert.rule_id == rule.id)
    ).all()
    if alert_ids and session.scalar(
        select(MaintenanceRecord.id)
        .where(MaintenanceRecord.alert_id.in_(alert_ids))
        .limit(1)
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "This rule has maintenance records linked to its alerts. "
                "Remove those links before permanently deleting the rule."
            ),
        )

    deleted_name = rule.name
    deleted_asset_id = rule.target_asset_id
    event_references = [MonitoringEvent.rule_id == rule.id]
    if alert_ids:
        event_references.append(MonitoringEvent.alert_id.in_(alert_ids))
    session.execute(
        delete(MonitoringEvent).where(or_(*event_references))
    )
    if alert_ids:
        session.execute(delete(Alert).where(Alert.id.in_(alert_ids)))
    session.execute(delete(RuleState).where(RuleState.rule_id == rule.id))
    session.delete(rule)
    session.flush()
    emit_event(
        session,
        event_type="rule_permanently_deleted",
        message=f"Monitoring rule '{deleted_name}' was permanently deleted.",
        occurred_at=datetime.now(timezone.utc),
        asset_id=deleted_asset_id,
        metadata={"deleted_rule_id": rule_id, "deleted_rule_name": deleted_name},
    )
    session.commit()

#Maintenance Logbook-> Returns maintenance records for an assest,ordered from newest to oldest
@router.get("/assets/{asset_id}/logbook")
def frontend_asset_logbook(
    asset_id: int,
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    rows = session.scalars(
        select(MaintenanceRecord)
        .where(MaintenanceRecord.asset_id == asset_id)
        .order_by(MaintenanceRecord.performed_at.desc())
    ).all()
    return [
        {
            "id": record.id,
            "time": record.performed_at.isoformat(),
            "text": record.summary + (f" — {record.notes}" if record.notes else ""),
        }
        for record in rows
    ]

#Add an entry (future implementation -> these records will be saved automatically when maintenance is done or pending or required)
@router.post("/assets/{asset_id}/logbook", status_code=201)
def frontend_add_logbook_entry(
    asset_id: int,
    payload: LogbookEntry,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    text_value = payload.text
    record = MaintenanceRecord(
        asset_id=asset_id,
        summary=text_value[:200],
        notes=text_value if len(text_value) > 200 else None,
        performed_by="Dashboard",
        performed_at=datetime.now(timezone.utc),
        actual_completed_at=datetime.now(timezone.utc),
        maintenance_type="inspection",
        status="completed",
        priority="medium",
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return {"id": record.id, "time": record.performed_at.isoformat(), "text": text_value}

#Machine events -> Returns the selected monitoring events for an asset
@router.get("/assets/{asset_id}/events")
def frontend_asset_events(
    asset_id: int,
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    events = session.scalars(
        select(MonitoringEvent)
        .where(
            MonitoringEvent.asset_id == asset_id,
            MonitoringEvent.event_type.in_(
                (
                    "rule_created",
                    "warning_triggered",
                    "alert_triggered",
                    "machine_stopped",
                )
            ),
        )
        .order_by(MonitoringEvent.occurred_at.desc())
        .limit(200)
    ).all()
    return [
        {"id": event.id, "time": event.occurred_at.isoformat(), "text": event.message}
        for event in events
    ]

#Rule Collections -> 
# List collections
@router.get("/collections")
def list_collections(session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = session.scalars(select(RuleCollection).order_by(RuleCollection.id)).all()
    return [{"id": row.id, "name": row.name, "description": row.description} for row in rows]

#Create a collecton
@router.post("/collections", status_code=201)
def create_collection(payload: CollectionCreate, session: Session = Depends(get_db)) -> dict[str, Any]:
    collection = RuleCollection(name=payload.name.strip(), description=payload.description)
    session.add(collection)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail="A collection with this name already exists") from error
    session.refresh(collection)
    return {"id": collection.id, "name": collection.name, "description": collection.description}

#Delete a collection
@router.delete("/collections/{collection_id}", status_code=204)
def delete_collection(collection_id: int, session: Session = Depends(get_db)) -> None:
    collection = session.get(RuleCollection, collection_id)
    if collection is None:
        raise HTTPException(status_code=404, detail="Collection was not found")
    session.delete(collection)
    session.commit()


@router.get("/instructions")
def list_maintenance_instructions(
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = session.scalars(
        select(MaintenanceInstruction).order_by(MaintenanceInstruction.id.desc())
    ).all()
    return [
        {
            "id": row.id,
            "name": row.name,
            "labels": row.labels,
            "duration_minutes": row.duration_minutes,
            "text": row.text,
        }
        for row in rows
    ]


@router.post("/instructions", status_code=201)
def create_maintenance_instruction(
    payload: InstructionCreate,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    instruction = MaintenanceInstruction(
        name=payload.name,
        labels=payload.labels,
        duration_minutes=payload.duration_minutes,
        text=payload.text,
    )
    session.add(instruction)
    session.commit()
    session.refresh(instruction)
    return {
        "id": instruction.id,
        "name": instruction.name,
        "labels": instruction.labels,
        "duration_minutes": instruction.duration_minutes,
        "text": instruction.text,
    }


#Instruction Documents
# Lists documents
@router.get("/documents")
def list_documents(session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = session.scalars(select(InstructionDocument).order_by(InstructionDocument.id)).all()
    result: list[dict[str, Any]] = []
    for row in rows:
        attachments = session.scalars(
            select(InstructionDocumentFile).where(InstructionDocumentFile.document_id == row.id)
            .order_by(InstructionDocumentFile.id)
        ).all()
        result.append({
            "id": row.id, "title": row.title, "kind": row.kind, "description": row.description,
            "files": [{"id": f.id, "name": f.original_name, "size_bytes": f.size_bytes,
                       "content_type": f.content_type,
                       "download_url": f"/api/v1/documents/{row.id}/files/{f.id}/download"}
                      for f in attachments],
        })
    return result

#Creates a document
@router.post("/documents", status_code=201)
def create_document(payload: DocumentCreate, session: Session = Depends(get_db)) -> dict[str, Any]:
    document = InstructionDocument(
        title=payload.title.strip(), kind=payload.kind.strip(), description=payload.description
    )
    session.add(document)
    session.commit()
    session.refresh(document)
    return {"id": document.id, "title": document.title, "kind": document.kind,
            "description": document.description}

# Create a document and store multiple attachments in the backend uploads directory.
@router.post("/documents/with-files", status_code=201)
async def create_document_with_files(
    title: str = Form(...),
    kind: str = Form(...),
    description: str = Form(""),
    files: list[UploadFile] = File(default=[]),
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    title, kind = title.strip(), kind.strip()
    if not title or not kind:
        raise HTTPException(status_code=422, detail="Title and type are required")
    if len(files) > MAX_FILES_PER_DOCUMENT:
        raise HTTPException(status_code=413, detail=f"Choose no more than {MAX_FILES_PER_DOCUMENT} files")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    total = 0
    try:
        document = InstructionDocument(title=title, kind=kind, description=description.strip() or None)
        session.add(document)
        session.flush()
        for upload in files:
            original = Path(upload.filename or "document").name
            suffix = Path(original).suffix.lower()
            if suffix not in ALLOWED_DOCUMENT_EXTENSIONS:
                raise HTTPException(status_code=415, detail=f"Unsupported file type: {original}. Allowed: PDF, DOC, DOCX, TXT")
            stored = f"{uuid4().hex}{suffix}"
            destination = UPLOAD_DIR / stored
            size = 0
            try:
                with destination.open("wb") as output:
                    while True:
                        chunk = await upload.read(1024 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        total += len(chunk)
                        if size > MAX_FILE_BYTES:
                            raise HTTPException(status_code=413, detail=f"{original} exceeds the 10 MB per-file limit")
                        if total > MAX_TOTAL_UPLOAD_BYTES:
                            raise HTTPException(status_code=413, detail="Combined uploads exceed the 24 MB limit")
                        output.write(chunk)
                saved_paths.append(destination)
            except Exception:
                destination.unlink(missing_ok=True)
                raise
            session.add(InstructionDocumentFile(
                document_id=document.id, original_name=original, stored_name=stored,
                content_type=upload.content_type, size_bytes=size,
            ))
        session.commit()
        session.refresh(document)
        return {"id": document.id, "title": document.title, "kind": document.kind,
                "description": document.description, "file_count": len(saved_paths)}
    except Exception:
        session.rollback()
        for path in saved_paths:
            path.unlink(missing_ok=True)
        raise
    finally:
        for upload in files:
            await upload.close()


@router.get("/documents/{document_id}/files/{file_id}/download")
def download_document_file(document_id: int, file_id: int, session: Session = Depends(get_db)):
    attachment = session.scalar(select(InstructionDocumentFile).where(
        InstructionDocumentFile.id == file_id,
        InstructionDocumentFile.document_id == document_id,
    ))
    if attachment is None:
        raise HTTPException(status_code=404, detail="Document attachment was not found")
    path = UPLOAD_DIR / attachment.stored_name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stored file is missing")
    return FileResponse(path, filename=attachment.original_name, media_type=attachment.content_type or "application/octet-stream")


#Delete a document
@router.delete("/documents/{document_id}", status_code=204)
def delete_document(document_id: int, session: Session = Depends(get_db)) -> None:
    document = session.get(InstructionDocument, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document was not found")
    attachments = session.scalars(select(InstructionDocumentFile).where(
        InstructionDocumentFile.document_id == document_id
    )).all()
    stored_paths = [UPLOAD_DIR / item.stored_name for item in attachments]
    for attachment in attachments:
        session.delete(attachment)
    session.delete(document)
    session.commit()
    for path in stored_paths:
        path.unlink(missing_ok=True)

#Importing configuration
@router.post("/import")
def import_configuration(
    payload: dict[str, Any],
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, int]:
    collections = payload.get("collections", [])
    if not isinstance(collections, list):
        raise HTTPException(status_code=422, detail="collections must be a list")
    created = 0
    for item in collections:
        try:
            data = CollectionCreate.model_validate(item)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail="Invalid collection in import file") from error
        if not session.scalar(select(RuleCollection.id).where(RuleCollection.name == data.name)):
            session.add(RuleCollection(name=data.name.strip(), description=data.description))
            created += 1
    rules = payload.get("rules", [])
    if not isinstance(rules, list):
        raise HTTPException(status_code=422, detail="rules must be a list")
    for item in rules:
        try:
            data = RuleCreate.model_validate(item)
        except ValidationError as error:
            raise HTTPException(status_code=422, detail="Invalid monitoring rule in import file") from error
        validate_targets(
            session, data.target_asset_id, data.variable_id, data.rule_type,
            data.operator, data.threshold, data.parameters,
            configured_cycle_signal_mapping(request, data.variable_id),
        )
        session.add(MonitoringRule(**data.model_dump()))
    session.commit()
    return {"rules": len(rules), "collections": created}

#User profile use FrontendConfig model to store user profile information, such as name, email, and phone number. The get_profile endpoint retrieves the profile from the database and returns it to the frontend.
# The update_profile endpoint allows the frontend to update the profile information in the database.
@router.get("/me")
def get_profile(session: Session = Depends(get_db)) -> dict[str, Any]:
    profile = _config(session, "profile")
    return {"name": profile.get("name", "Plant Operator"), "role": "Administrator",
            "email": profile.get("email", ""), "phone": profile.get("phone", "")}

#Validates and saves the new profile information
@router.put("/me")
def update_profile(payload: ProfileUpdate, session: Session = Depends(get_db)) -> dict[str, Any]:
    _save_config(session, "profile", payload.model_dump())
    return get_profile(session)

#Frontend settings
#only two sections are accepted : email and analytics
@router.get("/settings/{section}")
def get_frontend_settings(section: str, session: Session = Depends(get_db)) -> dict[str, Any]:
    if section not in {"email", "analytics", "connectivity"}:
        raise HTTPException(status_code=404, detail="Settings section was not found")
    value = _config(session, section)
    if section in {"email", "connectivity"}:
        secret_key = "password_ciphertext"
        has_password = bool(value.get(secret_key))
        public_value = {key: item for key, item in value.items() if key != secret_key}
        public_value["password"] = ""
        public_value["has_password"] = has_password
        if section == "connectivity":
            public_value.setdefault("databus_host", "mqtt://ie-databus:1883")
            public_value.setdefault("username", "")
            public_value.setdefault("discovery_topic", "$diapp/discovery")
            public_value.setdefault("enabled", "false")
        return public_value
    return value or {"databus_host": "mqtt://ie-databus:1883", "databus_port": "1883", "enabled": "false"}


@router.put("/settings/{section}")
def update_frontend_settings(
    section: str,
    payload: dict[str, Any],
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    if section not in {"email", "analytics", "connectivity"}:
        raise HTTPException(status_code=404, detail="Settings section was not found")
    value = _config(session, section)
    if section in {"email", "connectivity"}:
        password = str(payload.pop("password", "") or "")
        payload.pop("password_ciphertext", None)
        payload.pop("has_password", None)
        existing_ciphertext = value.get("password_ciphertext")
        value.update(payload)
        if password:
            value["password_ciphertext"] = _fernet(request).encrypt(password.encode()).decode("ascii")
        elif existing_ciphertext:
            value["password_ciphertext"] = existing_ciphertext
        _save_config(session, section, value)
        public_value = {key: item for key, item in value.items() if key != "password_ciphertext"}
        return {**public_value, "password": "", "has_password": bool(value.get("password_ciphertext"))}
    _save_config(session, section, payload)
    return payload

#Usage statistics
#Assets,variables,readings,rules,alerts,maintenance records
@router.get("/usage")
def frontend_usage(session: Session = Depends(get_db)) -> dict[str, int]:
    return {
        "assets": session.query(Asset).count(),
        "variables": session.query(Variable).count(),
        "readings": session.query(Reading).count(),
        "rules": session.query(MonitoringRule).count(),
        "alerts": session.query(Alert).count(),
        "maintenance_records": session.query(MaintenanceRecord).count(),
    }

#List backups
@router.get("/backups")
def list_frontend_backups(session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    records = session.scalars(select(BackupRecord).order_by(BackupRecord.created_at.desc())).all()
    return [
        {"id": item.id, "name": item.name, "note": item.note, "created": item.created_at.isoformat()}
        for item in records
    ]

#Create a backup
@router.post("/backups", status_code=201)
def create_frontend_backup(
    payload: BackupCreate,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    name = (payload.name or "").strip() or f"Backup {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}"
    if len(name) > 200:
        raise HTTPException(status_code=422, detail="Backup name cannot exceed 200 characters")
    record = create_backup(session, request.app.state.settings, name, payload.note)
    return {"id": record.id, "name": record.name, "note": record.note,
            "created": record.created_at.isoformat()}

#Restore a backup
@router.post("/backups/{backup_id}/restore")
def restore_frontend_backup(
    backup_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, str]:
    record = session.get(BackupRecord, backup_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Backup was not found")
    restore_backup(
        session, request.app.state.engine, request.app.state.settings, record.file_name
    )
    return {"status": "restored", "name": record.name}
