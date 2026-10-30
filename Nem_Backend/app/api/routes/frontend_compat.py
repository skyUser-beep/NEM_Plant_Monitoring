#FastApi router that connects your react frontend to your backend and postgreSQL database

# React Frontend <-> FASTAPI router(this file) <-> POSTGRESQL database
from datetime import datetime, timezone
from html import escape
import json
import mimetypes
from pathlib import Path
from uuid import uuid4
from zipfile import BadZipFile
from typing import Any, Literal

from cryptography.fernet import Fernet # encrypts and decrypts sensitive values, such as a saved email password
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field, ValidationError, field_validator 
from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError # Handles database constraint failures,such as duplicate collection name
from sqlalchemy.orm import Session 
from docx import Document as WordDocument
from docx.opc.exceptions import PackageNotFoundError

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
    MonitoringRuleTemplate,
    MonitoringRuleTemplateRequest,
    Reading,
    RuleCounterState,
    RuleCollection,
    RuleState,
    User,
    Variable,
)
from app.schemas.rule import (
    RuleCopyRequest,
    RuleCreate,
    RuleSelection,
    RuleTemplateAssetAssignment,
    RuleTemplateCreate,
    RuleTemplateRead,
    UsageRuleCreate,
)
from app.schemas.maintenance import MaintenanceScheduleCreate
from app.services.frontend_backup import create_backup, restore_backup
from app.services.monitoring_engine import (emit_event,resolve_active_rule_alerts,set_rule_enabled_state,)
from app.api.routes.rules import (
    configured_cycle_signal_mapping,
    configured_runtime_signal_mapping,
    is_mapping_bypass_enabled,
    validate_targets,
)
from app.api.routes.monitoring import state_for_rule
from app.api.routes.auth import get_current_user, require_roles

router = APIRouter(tags=["frontend compatibility"])

UPLOAD_DIR = Path(__file__).resolve().parents[3] / "uploads" / "instruction_documents"

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_UPLOAD_BYTES = 24 * 1024 * 1024
MAX_FILES_PER_DOCUMENT = 10

ALLOWED_DOCUMENT_EXTENSIONS = {".pdf", ".doc", ".docx", ".txt"}

#Validate a rule collection`s name and description.
class CollectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None
    rules: list[RuleTemplateCreate] | None = Field(default=None, min_length=1, max_length=5)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Collection name cannot be empty")
        return value


class MaintenanceSuggestionPayload(BaseModel):
    suggestion_type: Literal["maintenance"]
    maintenance: MaintenanceScheduleCreate

#Validate an instruction document`s title and type
class DocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    kind: str = Field(min_length=1, max_length=50)
    description: str | None = None
    labels: list[str] = Field(default_factory=list, max_length=10)
    duration_minutes: int | None = Field(default=None, ge=1)

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
    variable = session.get(Variable, rule.variable_id) if rule.variable_id else None
    return {
        "id": rule.id,
        "name": rule.name,
        "description": rule.description,
        "asset_id": rule.target_asset_id,
        "asset_name": asset.name if asset else "",
        "severity": rule.severity,
        "state": "activated" if rule.is_enabled else rule.lifecycle_status,
        "is_enabled": rule.is_enabled,
        "lifecycle_status": rule.lifecycle_status,
        "completed_at": rule.completed_at,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
        "status": (
            "evaluated"
            if rule.lifecycle_status == "completed"
            else {"normal": "ok"}.get(state.status, state.status)
            if rule.is_enabled
            else "unknown"
        ),
        "current_status": (
            "evaluated"
            if rule.lifecycle_status == "completed"
            else state.status
        ),
        "evaluation_status": state.status,
        "evaluation_message": state.message,
        "evaluation_error": state.error_message,
        "latest_value": state.latest_value,
        "last_evaluated_at": state.last_evaluated_at,
        "condition_started_at": state.condition_started_at,
        "rule_type": rule.rule_type,
        "source_template_id": rule.source_template_id,
        "variable_id": rule.variable_id,
        "variable_name": variable.name if variable else None,
        "variable_key": variable.key if variable else None,
        "variable_data_type": variable.data_type if variable else None,
        "variable_unit": variable.unit if variable else None,
        "operator": rule.operator,
        "threshold": float(rule.threshold) if rule.threshold is not None else None,
        "parameters": rule.parameters,
        "evaluation_interval_seconds": rule.evaluation_interval_seconds,
        "stale_after_seconds": rule.stale_after_seconds,
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
    lifecycle_counts = {
        status: session.scalar(
            select(func.count())
            .select_from(MonitoringRule)
            .where(
                MonitoringRule.lifecycle_status == status,
                MonitoringRule.is_archived.is_(False),
            )
        )
        or 0
        for status in ("in_progress", "suspended", "deactivated", "completed")
    }
    return {
        "rules_alert": summary.rules_alert,
        "rules_warning": summary.rules_warning,
        "assets_alert": summary.assets_in_alert_state,
        "assets_warning": summary.assets_in_warning_state,
        "monitored_assets": summary.monitored_assets,
        "total_assets": summary.total_assets,
        "stats": {
            "activated": lifecycle_counts["in_progress"],
            "in_progress": lifecycle_counts["in_progress"],
            "suspended": lifecycle_counts["suspended"],
            "deactivated": lifecycle_counts["deactivated"],
            "completed": lifecycle_counts["completed"],
            "not_activated": lifecycle_counts["deactivated"],
        },
    }

#Reading and filtering machine rules
#Rules by lifecycle state
@router.get("/rules/lifecycle/{lifecycle_status}")
def frontend_rules_by_lifecycle(
    lifecycle_status: str,
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    allowed_statuses = {"in_progress", "suspended", "deactivated", "completed"}
    if lifecycle_status not in allowed_statuses:
        raise HTTPException(status_code=422,detail="Rule lifecycle status must be in_progress, suspended, deactivated, or completed",)
    rules = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.lifecycle_status == lifecycle_status,
            MonitoringRule.is_archived.is_(False),
            MonitoringRule.target_asset_id.is_not(None),
        )
        .order_by(MonitoringRule.target_asset_id, MonitoringRule.id)
    ).all()
    return [_rule_row(session, rule) for rule in rules]


#Rules by status
@router.get("/rules/status/{kind}")
def frontend_rules_by_status(kind: str, session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    if kind not in {"alert", "warning"}:
        raise HTTPException(status_code=422, detail="Rule status must be alert or warning")
    rows = session.scalars(
        select(MonitoringRule)
        .where(
            MonitoringRule.is_archived.is_(False),
            MonitoringRule.target_asset_id.is_not(None),
        )
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
        raise HTTPException(status_code=422,detail=(f"Rule variable '{source.key}' must have exactly one active variable with the same key and data type on the target asset"),)
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
        "source_template_id": source.source_template_id,
        "variable_id": variable.id if variable else None,
        "operator": source.operator,
        "threshold": source.threshold,
        "parameters": source.parameters,
        "severity": source.severity,
        "is_enabled": False,
        "lifecycle_status": "deactivated",
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

#Helper function for assigning templates -> finds variables on a target asset that are compatible with a template
def _template_variables(
    session: Session,
    template: MonitoringRuleTemplate,
    asset_id: int,
    *,
    mapping_bypass_enabled: bool = False,
    request: Request | None = None,
) -> list[Variable]:
        if not template.required_variable_types:
            return []
        query = select(Variable)
        query = query.where(
                Variable.asset_id == asset_id,
                Variable.is_active.is_(True),
                Variable.data_type.in_(template.required_variable_types),
            )
        candidates = session.scalars(
            query.order_by(Variable.name, Variable.id)
        ).all()
        if not mapping_bypass_enabled:
            return candidates
        required_role = (
            "running"
            if template.rule_type == "runtime_duration"
            or (
                template.rule_type == "duration"
                and isinstance(
                    (template.parameters or {}).get("expected_value"), bool
                )
            )
            else "cycle"
            if template.rule_type == "boolean_count_threshold"
            else None
        )
        if required_role is None:
            return candidates
        configured_variable_ids = set()
        if request is not None:
            mapping_function = (
                configured_runtime_signal_mapping
                if required_role == "running"
                else configured_cycle_signal_mapping
            )
            configured_variable_ids = {
                variable.id
                for variable in candidates
                if mapping_function(request, variable.id)
                == (asset_id, variable.id)
            }
        return [
            variable
            for variable in candidates
            if variable.signal_role == required_role
            or variable.id in configured_variable_ids
        ]

#Function decides which compatible variable to use
def _mapped_template_variable(
        template: MonitoringRuleTemplate,
        candidates: list[Variable],
        requested_variable_id: int | None,
) -> Variable | None:
        if not template.required_variable_types:
            if requested_variable_id is not None:
                raise HTTPException(status_code=422,detail=f"Rule '{template.name}' does not require a variable",)
            return None
        if requested_variable_id is not None:
            mapped = next((item for item in candidates if item.id == requested_variable_id), None)
            if mapped is None:
                raise HTTPException(status_code=422,detail=(f"Variable {requested_variable_id} is not an active compatible "
                        f"variable on the target asset for '{template.name}'"),)
            return mapped

        if template.variable_key:
            key_matches = [item
                for item in candidates
                if item.key.casefold() == template.variable_key.casefold()
            ]
            if len(key_matches) == 1:
                return key_matches[0]
        if len(candidates) == 1:
            return candidates[0]
        if not candidates:
            raise HTTPException(status_code=422,detail=(f"No active compatible variable is available for "
                    f"'{template.name}' on the target asset"),)
        raise HTTPException(status_code=422,detail=f"Choose a variable for '{template.name}' on the target asset",)

#used to suggest a variable rather than requie a final selection
def _suggested_template_variable(template: MonitoringRuleTemplate, candidates: list[Variable]) -> Variable | None:
        if not template.required_variable_types:
            return None
        if template.variable_key:
            key_matches = [
                item
                for item in candidates
                if item.key.casefold() == template.variable_key.casefold()
            ]
            if len(key_matches) == 1:
                return key_matches[0]
        return candidates[0] if len(candidates) == 1 else None

#function converts a reusable template into the definition of a rule for a specific asset
def _template_rule_definition(
        session: Session,
        template: MonitoringRuleTemplate,
        asset_id: int,
        request: Request,
        requested_variable_id: int | None,
        *,
        allow_disabled: bool = False,
) -> dict[str, Any]:
        if not template.is_enabled and not allow_disabled:
            raise HTTPException(status_code=422, detail=f"Rule template '{template.name}' is disabled")
        candidates = _template_variables(
            session,
            template,
            asset_id,
            mapping_bypass_enabled=is_mapping_bypass_enabled(request),
            request=request,
        )
        variable = _mapped_template_variable(template, candidates, requested_variable_id)
        definition = {
            "name": template.name,
            "description": template.description,
            "rule_type": template.rule_type,
            "target_asset_id": asset_id,
            "variable_id": variable.id if variable else None,
            "operator": template.operator,
            "threshold": template.threshold,
            "parameters": template.parameters,
            "severity": template.severity,
            "is_enabled": False,
            "lifecycle_status": "deactivated",
            "evaluation_interval_seconds": template.evaluation_interval_seconds,
            "stale_after_seconds": template.stale_after_seconds,
            "source_template_id": template.id,
        }
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
            configured_runtime_signal_mapping(request, validated.variable_id),
            is_mapping_bypass_enabled(request),
        )
        return definition

#LIsting templates - builds a db query and optionally filters by name,type,status
@router.get("/rule-templates", response_model=list[RuleTemplateRead])
def list_rule_templates(
        search: str | None = None,
        rule_type: str | None = None,
        is_enabled: bool | None = None,
        session: Session = Depends(get_db),
) -> list[MonitoringRuleTemplate]:
        query = select(MonitoringRuleTemplate)
        if search and search.strip():
            pattern = f"%{search.strip()}%"
            query = query.where(
                or_(
                    MonitoringRuleTemplate.name.ilike(pattern),
                    MonitoringRuleTemplate.description.ilike(pattern),
                )
            )
        if rule_type:
            query = query.where(MonitoringRuleTemplate.rule_type == rule_type)
        if is_enabled is not None:
            query = query.where(MonitoringRuleTemplate.is_enabled.is_(is_enabled))
        return session.scalars(
            query.order_by(MonitoringRuleTemplate.name, MonitoringRuleTemplate.id)
        ).all()


def _validate_template_collection(
    session: Session,
    collection_id: int | None,
    excluded_template_id: int | None = None,
) -> None:
        if collection_id is None:
            return
        if session.get(RuleCollection, collection_id) is None:
            raise HTTPException(status_code=404, detail="Rule collection was not found")
        query = select(func.count()).select_from(MonitoringRuleTemplate).where(MonitoringRuleTemplate.collection_id == collection_id)
        if excluded_template_id is not None:
            query = query.where(MonitoringRuleTemplate.id != excluded_template_id)
        if (session.scalar(query) or 0) >= 5:
            raise HTTPException(status_code=422,detail="A rule collection can contain no more than five rules",)


def _rule_template_request_row(
    item: MonitoringRuleTemplateRequest,
    session: Session,
) -> dict[str, Any]:
    requester = session.get(User, item.requested_by)
    reviewer = (
        session.get(User, item.reviewed_by)
        if item.reviewed_by is not None
        else None
    )
    maintenance_details = item.maintenance_details
    asset = (
        session.get(Asset, maintenance_details.get("asset_id"))
        if maintenance_details and maintenance_details.get("asset_id")
        else None
    )
    return {
        "id": item.id,
        "suggestion_type": item.suggestion_type,
        "name": item.name,
        "description": item.description,
        "rule_type": item.rule_type,
        "required_variable_types": item.required_variable_types,
        "variable_key": item.variable_key,
        "operator": item.operator,
        "threshold": float(item.threshold) if item.threshold is not None else None,
        "parameters": item.parameters,
        "severity": item.severity,
        "is_enabled": item.is_enabled,
        "evaluation_interval_seconds": item.evaluation_interval_seconds,
        "stale_after_seconds": item.stale_after_seconds,
        "collection_id": item.collection_id,
        "requested_by": item.requested_by,
        "status": item.status,
        "reviewed_by": item.reviewed_by,
        "requested_by_name": requester.username if requester else None,
        "reviewed_by_name": reviewer.username if reviewer else None,
        "reviewed_at": (
            item.reviewed_at.isoformat() if item.reviewed_at else None
        ),
        "review_comment": item.review_comment,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "maintenance_details": maintenance_details,
        "maintenance_asset_name": asset.name if asset else None,
    }


def _authenticated_user(request: Request, session: Session) -> User:
    user_id = getattr(request.state, "auth_user_id", None)
    user = session.get(User, user_id) if user_id is not None else None

    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Authentication required")

    return user


@router.post("/rule-template-requests", status_code=201)
def submit_rule_template_request(
    payload: RuleTemplateCreate | MaintenanceSuggestionPayload,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _authenticated_user(request, session)

    if user.role != "Supervisor":
        raise HTTPException(status_code=403,detail="Only Supervisors can suggest reusable monitoring rules",)

    if isinstance(payload, MaintenanceSuggestionPayload):
        maintenance = payload.maintenance
        if session.get(Asset, maintenance.asset_id) is None:
            raise HTTPException(
                status_code=404,
                detail=f"Asset {maintenance.asset_id} was not found",
            )
        from app.api.routes.maintenance import _validate_instruction_documents

        maintenance = maintenance.model_copy(
            update={
                "instruction_document_ids": _validate_instruction_documents(
                    session,
                    maintenance.instruction_document_ids,
                )
            }
        )
        item = MonitoringRuleTemplateRequest(
            name=maintenance.title,
            description=maintenance.description,
            rule_type="maintenance_schedule",
            severity="warning",
            is_enabled=False,
            requested_by=user.id,
            status="pending",
            suggestion_type="maintenance",
            maintenance_details=maintenance.model_dump(mode="json"),
        )
    else:
        _validate_template_collection(session, payload.collection_id)
        item = MonitoringRuleTemplateRequest(
            **payload.model_dump(),
            requested_by=user.id,
            status="pending",
            suggestion_type="monitoring_rule",
        )
    session.add(item)
    session.commit()
    session.refresh(item)

    return _rule_template_request_row(item, session)


@router.get("/rule-template-requests")
def list_rule_template_requests(
    request: Request,
    status: str | None = None,
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    user = _authenticated_user(request, session)

    if user.role != "Administrator":
        raise HTTPException(status_code=403,detail="Only Administrators can review rule suggestions",)

    query = select(MonitoringRuleTemplateRequest)

    if status:
        if status not in {"pending", "approved", "declined"}:
            raise HTTPException(status_code=422, detail="Invalid request status")
        query = query.where(MonitoringRuleTemplateRequest.status == status)

    items = session.scalars(
        query.order_by(
            MonitoringRuleTemplateRequest.created_at.desc(),
            MonitoringRuleTemplateRequest.id.desc(),
        )
    ).all()

    return [_rule_template_request_row(item, session) for item in items]


@router.post("/rule-template-requests/{request_id}/approve")
def approve_rule_template_request(
    request_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _authenticated_user(request, session)

    if user.role != "Administrator":
        raise HTTPException(status_code=403, detail="Administrator access required")

    item = session.scalar(
        select(MonitoringRuleTemplateRequest)
        .where(MonitoringRuleTemplateRequest.id == request_id)
        .with_for_update()
    )

    if item is None:
        raise HTTPException(status_code=404, detail="Rule suggestion was not found")

    if item.status != "pending":
        raise HTTPException(status_code=409, detail="This suggestion has already been reviewed")

    if item.suggestion_type == "maintenance":
        if not item.maintenance_details:
            raise HTTPException(
                status_code=409,
                detail="The maintenance suggestion is missing its schedule details.",
            )
        from app.api.routes.maintenance import _create_maintenance_schedule

        try:
            maintenance = MaintenanceScheduleCreate.model_validate(
                item.maintenance_details
            )
            schedule = _create_maintenance_schedule(session, maintenance)
            item.status = "approved"
            item.reviewed_by = user.id
            item.reviewed_at = datetime.now(timezone.utc)
            session.commit()
        except HTTPException:
            session.rollback()
            raise
        except ValidationError as error:
            session.rollback()
            raise HTTPException(
                status_code=409,
                detail="The maintenance suggestion contains invalid schedule details.",
            ) from error
        except IntegrityError as error:
            session.rollback()
            raise HTTPException(
                status_code=409,
                detail="The maintenance schedule could not be created because related data changed.",
            ) from error
        return {
            "status": "approved",
            "request_id": item.id,
            "suggestion_type": item.suggestion_type,
            "schedule_id": schedule.id,
        }

    _validate_template_collection(session, item.collection_id)
    template = MonitoringRuleTemplate(
        name=item.name,
        description=item.description,
        rule_type=item.rule_type,
        required_variable_types=item.required_variable_types,
        variable_key=item.variable_key,
        operator=item.operator,
        threshold=item.threshold,
        parameters=item.parameters,
        severity=item.severity,
        is_enabled=item.is_enabled,
        evaluation_interval_seconds=item.evaluation_interval_seconds,
        stale_after_seconds=item.stale_after_seconds,
        collection_id=item.collection_id,
    )

    session.add(template)
    item.status = "approved"
    item.reviewed_by = user.id
    item.reviewed_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(template)

    return {
        "status": "approved",
        "request_id": item.id,
        "suggestion_type": item.suggestion_type,
        "template": RuleTemplateRead.model_validate(template).model_dump(mode="json"),
    }


@router.post("/rule-template-requests/{request_id}/decline")
def decline_rule_template_request(
    request_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _authenticated_user(request, session)

    if user.role != "Administrator":
        raise HTTPException(status_code=403, detail="Administrator access required")

    item = session.scalar(
        select(MonitoringRuleTemplateRequest)
        .where(MonitoringRuleTemplateRequest.id == request_id)
        .with_for_update()
    )

    if item is None:
        raise HTTPException(status_code=404, detail="Rule suggestion was not found")

    if item.status != "pending":
        raise HTTPException(status_code=409, detail="This suggestion has already been reviewed")

    item.status = "declined"
    item.reviewed_by = user.id
    item.reviewed_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(item)

    return _rule_template_request_row(item, session)
    
#Creating a template not an asset-specific rule - templates are reusable definitions that can be assigned to multiple assets
@router.post("/rule-templates", response_model=RuleTemplateRead, status_code=201)
def create_rule_template(
        payload: RuleTemplateCreate, session: Session = Depends(get_db)
) -> MonitoringRuleTemplate:
        _validate_template_collection(session, payload.collection_id)
        template = MonitoringRuleTemplate(**payload.model_dump())
        session.add(template)
        session.commit()
        session.refresh(template)
        return template


@router.get("/rule-templates/{template_id}", response_model=RuleTemplateRead)
def get_rule_template(template_id: int, session: Session = Depends(get_db)
) -> MonitoringRuleTemplate:
        template = session.get(MonitoringRuleTemplate, template_id)
        if template is None:
            raise HTTPException(status_code=404, detail="Rule template was not found")
        return template

#Retrieves the template and replaces its fields with the values in the request
@router.put("/rule-templates/{template_id}", response_model=RuleTemplateRead)
def update_rule_template(
        template_id: int,
        payload: RuleTemplateCreate,
        request: Request,
        session: Session = Depends(get_db),
) -> MonitoringRuleTemplate:
        template = session.get(MonitoringRuleTemplate, template_id)
        if template is None:
            raise HTTPException(status_code=404, detail="Rule template was not found")
        values = payload.model_dump()
        if values["collection_id"] != template.collection_id:
            _validate_template_collection(session, values["collection_id"], excluded_template_id=template.id)
        semantic_fields = (
            "rule_type",
            "required_variable_types",
            "variable_key",
            "operator",
            "threshold",
            "parameters",
            "severity",
            "evaluation_interval_seconds",
            "stale_after_seconds",
        )
        definition_changed = any(
            getattr(template, field) != values[field]
            for field in semantic_fields
        )
        for field, value in values.items():
            setattr(template, field, value)
        if definition_changed:
            assigned_rules = session.scalars(
                select(MonitoringRule).where(
                    MonitoringRule.source_template_id == template.id,
                    MonitoringRule.is_archived.is_(False),
                )
            ).all()
            for rule in assigned_rules:
                definition = _template_rule_definition(
                    session,
                    template,
                    rule.target_asset_id,
                    request,
                    rule.variable_id,
                    allow_disabled=True,
                )
                for field in (
                    "name",
                    "description",
                    "rule_type",
                    "operator",
                    "threshold",
                    "parameters",
                    "severity",
                    "evaluation_interval_seconds",
                    "stale_after_seconds",
                ):
                    setattr(rule, field, definition[field])
        session.commit()
        session.refresh(template)
        return template

#if template has assigned rules,it cannot be deleted 
@router.delete("/rule-templates/{template_id}", status_code=204)
def delete_rule_template(template_id: int, session: Session = Depends(get_db)) -> None:
        template = session.get(MonitoringRuleTemplate, template_id)
        if template is None:
            raise HTTPException(status_code=404, detail="Rule template was not found")
        assigned_count = session.scalar(
            select(func.count())
            .select_from(MonitoringRule)
            .where(MonitoringRule.source_template_id == template_id)
        )
        if assigned_count:
            raise HTTPException(status_code=409,detail="This template has assigned rules; disable it instead of deleting it",)
        session.delete(template)
        session.commit()

#this endpoint assigns one template to multiple assets, load -> check reqest-> validate -> 
# resolve the variable mapping -> create missing assest-specific rules -> emit a rule_created -> commit the transaction -> return the created rule 
@router.post("/rule-templates/{template_id}/assign", status_code=201)
def assign_template_to_assets(
        template_id: int,
        payload: RuleTemplateAssetAssignment,
        request: Request,
        session: Session = Depends(get_db),
) -> dict[str, Any]:
        template = session.get(MonitoringRuleTemplate, template_id)
        if template is None:
            raise HTTPException(status_code=404, detail="Rule template was not found")
        prepared = []
        already_assigned = []
        for asset_id in sorted(payload.asset_ids):
            asset = session.scalar(select(Asset).where(Asset.id == asset_id).with_for_update())
            if asset is None:
                raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
            definition = _template_rule_definition(
                session,
                template,
                asset_id,
                request,
                payload.variable_mappings.get(asset_id),
            )
            existing = session.scalars(
                select(MonitoringRule)
                .where(
                    MonitoringRule.target_asset_id == asset_id,
                    MonitoringRule.is_archived.is_(False),
                )
                .with_for_update()
            ).all()
            if any(
                rule.source_template_id == template.id
                or _same_rule_definition(rule, definition)
                for rule in existing
            ):
                already_assigned.append(asset_id)
            else:
                prepared.append((asset_id, definition))

        created = []
        for asset_id, definition in prepared:
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
            created.append({"asset_id": asset_id, "id": rule.id, "name": rule.name})
        session.commit()
        return {"created": created, "already_assigned": already_assigned}

#endpoint loads the templates library for a particular asset and provides info. needed by assignment dialog
@router.get("/assets/{asset_id}/rules/predefined")
def frontend_predefined_rules(
    asset_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    templates = session.scalars(
        select(MonitoringRuleTemplate).order_by(
            MonitoringRuleTemplate.name, MonitoringRuleTemplate.id
        )
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
        candidates = _template_variables(
            session,
            template,
            asset_id,
            mapping_bypass_enabled=is_mapping_bypass_enabled(request),
            request=request,
        )
        mapped = _suggested_template_variable(template, candidates)
        definition = None
        mapping_required = bool(template.required_variable_types and candidates and mapped is None)
        try:
            if not template.is_enabled:
                raise HTTPException(status_code=422,detail=f"Rule template '{template.name}' is disabled",)
            if template.required_variable_types and not candidates:
                required_role = (
                    "Machine running state"
                    if template.rule_type == "runtime_duration"
                    or (
                        template.rule_type == "duration"
                        and isinstance(
                            (template.parameters or {}).get("expected_value"),
                            bool,
                        )
                    )
                    else "Cycle signal"
                    if template.rule_type == "boolean_count_threshold"
                    else None
                )
                if is_mapping_bypass_enabled(request) and required_role:
                    raise HTTPException(status_code=422,detail=(
                            f"Set an active Boolean variable's purpose to "
                            f"'{required_role}' in the asset's Variables panel"
                        ),
                    )
                raise HTTPException(status_code=422,detail=(
                        f"No active compatible variable is available for "
                        f"'{template.name}' on the target asset"
                    ),
                )
            if not mapping_required:
                definition = _template_rule_definition(
                    session,
                    template,
                    asset_id,
                    request,
                    mapped.id if mapped else None,
                )
            else:
                _template_rule_definition(session, template, asset_id, request, candidates[0].id)
        except HTTPException as error:
            reason = str(error.detail)
        duplicate = bool(
            definition
            and any(
                rule.source_template_id == template.id
                or _same_rule_definition(rule, definition)
                for rule in assigned
            )
        )
        result.append(
            {**RuleTemplateRead.model_validate(template).model_dump(mode="json"),
                "assigned": duplicate,
                "unavailable_reason": reason,
                "variable_mapping_required": mapping_required,
                "mapped_variable_name": mapped.name if mapped else None,
                "compatible_variables": [
                    {
                        "id": variable.id,
                        "name": variable.name,
                        "key": variable.key,
                        "data_type": variable.data_type,
                    }
                    for variable in candidates
                ],
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
    if session.scalar(
        select(Asset).where(Asset.id == asset_id).with_for_update()
    ) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    templates = session.scalars(
        select(MonitoringRuleTemplate)
        .where(MonitoringRuleTemplate.id.in_(payload.rule_ids))
        .order_by(MonitoringRuleTemplate.id)
        .with_for_update()
    ).all()
    if len(templates) != len(payload.rule_ids):
        raise HTTPException(status_code=404,detail="One or more selected rule templates are unavailable",)
    existing = session.scalars(
        select(MonitoringRule).where(
            MonitoringRule.target_asset_id == asset_id,
            MonitoringRule.is_archived.is_(False),
        )
    ).all()
    prepared: list[tuple[MonitoringRuleTemplate, dict[str, Any]]] = []
    already_assigned = []
    for template in templates:
        definition = _template_rule_definition(
            session,
            template,
            asset_id,
            request,
            payload.variable_mappings.get(template.id),
        )
        if any(
            rule.source_template_id == template.id
            or _same_rule_definition(rule, definition)
            for rule in existing
        ):
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

#This endpoint copies selected asset-specific rules to another asset.
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
        raise HTTPException(status_code=404,detail=f"Source asset {payload.source_asset_id} was not found",)
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
        raise HTTPException(status_code=404, detail="One or more selected source rules are unavailable",)
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
            raise HTTPException(status_code=422,detail=f"Rule '{source.name}' has no monitoring evaluator and cannot be copied",)
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
            configured_runtime_signal_mapping(request, validated.variable_id),
            is_mapping_bypass_enabled(request),
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
        configured_runtime_signal_mapping(request, payload.variable_id),
        is_mapping_bypass_enabled(request),
    )
    rule_data = payload.model_dump()
    rule_data["lifecycle_status"] = (
        "in_progress" if payload.is_enabled else "deactivated"
    )
    rule = MonitoringRule(**rule_data)
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

#created a usage -threshold rule for a variable
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
        configured_runtime_signal_mapping(request, rule_payload.variable_id),
        is_mapping_bypass_enabled(request),
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
    raise HTTPException(status_code=410,
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
        if rule.lifecycle_status == "completed":
            skipped.append({
                "rule_id": rule.id,
                "name": rule.name,
                "reason": "Completed rules cannot be reactivated.",
            })
            continue
        if rule.is_enabled == enabled:
            continue
        if enabled:
            try:
                if rule.rule_type == "generic":
                    raise HTTPException(status_code=422,detail="This rule type has no monitoring evaluator",)
                validate_targets(
                    session,
                    rule.target_asset_id,
                    rule.variable_id,
                    rule.rule_type,
                    rule.operator,
                    rule.threshold,
                    rule.parameters,
                    configured_cycle_signal_mapping(request, rule.variable_id),
                    configured_runtime_signal_mapping(request, rule.variable_id),
                    is_mapping_bypass_enabled(request),
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


def _transition_rule_lifecycle(
    rule_id: int,
    action: str,
    request: Request,
    session: Session,
) -> dict[str, Any]:
    rule = session.scalar(
        select(MonitoringRule)
        .where(MonitoringRule.id == rule_id)
        .with_for_update()
    )
    if rule is None or rule.is_archived:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")

    now = datetime.now(timezone.utc)
    current = rule.lifecycle_status
    if action == "suspend":
        if current != "in_progress" or not rule.is_enabled:
            raise HTTPException(status_code=409, detail="Only an active rule can be suspended.")
        set_rule_enabled_state(session, rule, False, at=now)
        rule.lifecycle_status = "suspended"
        event_type = "rule_suspended"
    elif action in {"resume", "activate"}:
        expected = "suspended" if action == "resume" else "deactivated"
        if current != expected or rule.is_enabled:
            raise HTTPException(status_code=409, detail=f"Only a {expected} rule can be {action}d.",)
        if rule.rule_type == "generic":
            raise HTTPException(status_code=422, detail="This rule type has no monitoring evaluator.")
        validate_targets(
            session,
            rule.target_asset_id,
            rule.variable_id,
            rule.rule_type,
            rule.operator,
            rule.threshold,
            rule.parameters,
            configured_cycle_signal_mapping(request, rule.variable_id),
            configured_runtime_signal_mapping(request, rule.variable_id),
            is_mapping_bypass_enabled(request),
        )
        set_rule_enabled_state(session, rule, True, at=now)
        rule.lifecycle_status = "in_progress"
        rule.completed_at = None
        event_type = "rule_resumed" if action == "resume" else "rule_activated"
    elif action == "deactivate":
        if current not in {"in_progress", "suspended"}:
            raise HTTPException(status_code=409, detail="Only an active or suspended rule can be deactivated.")
        if rule.is_enabled:
            set_rule_enabled_state(session, rule, False, at=now)
        rule.lifecycle_status = "deactivated"
        event_type = "rule_deactivated"
    else:
        raise HTTPException(status_code=422, detail="Unsupported lifecycle action.")

    emit_event(
        session,
        event_type=event_type,
        message=(
            f"Rule '{rule.name}' "
            f"{ {'suspend': 'suspended', 'resume': 'resumed', 'activate': 'activated', 'deactivate': 'deactivated'}[action] }."
        ),
        occurred_at=now,
        asset_id=rule.target_asset_id,
        rule_id=rule.id,
    )
    session.commit()
    session.refresh(rule)
    return _rule_row(session, rule)


@router.post("/rules/{rule_id}/suspend")
def suspend_rule(
    rule_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    return _transition_rule_lifecycle(rule_id, "suspend", request, session)


@router.post("/rules/{rule_id}/resume")
def resume_rule(
    rule_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    return _transition_rule_lifecycle(rule_id, "resume", request, session)


@router.post("/rules/{rule_id}/activate")
def activate_rule(
    rule_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    return _transition_rule_lifecycle(rule_id, "activate", request, session)


@router.post("/rules/{rule_id}/deactivate")
def deactivate_rule(
    rule_id: int,
    request: Request,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    return _transition_rule_lifecycle(rule_id, "deactivate", request, session)


#Deleting a rule(Soft deletion,also called archiving rather than deleting the db row)
@router.delete("/rules/{rule_id}", status_code=204)
def frontend_delete_rule(
    rule_id: int,
    session: Session = Depends(get_db),
    user: User = Depends(require_roles("Administrator")),
) -> None:
    rule = session.get(MonitoringRule, rule_id)
    if rule is None or rule.is_archived:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    if rule.is_enabled:
        raise HTTPException( status_code=409, detail="Deactivate the rule before archiving it.")
    set_rule_enabled_state(session, rule, False)
    resolve_active_rule_alerts(session, rule.id)
    rule.is_archived = True
    if rule.lifecycle_status != "completed":
        rule.lifecycle_status = "deactivated"
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
    user: User = Depends(require_roles("Administrator")),
) -> None:
    rule = session.scalar(
        select(MonitoringRule)
        .where(MonitoringRule.id == rule_id)
        .with_for_update()
    )
    if rule is None:
        raise HTTPException(status_code=404, detail=f"Rule {rule_id} was not found")
    if rule.is_enabled:
        raise HTTPException(status_code=409,detail="Deactivate the rule before permanently deleting it.",)

    alert_ids = session.scalars(
        select(Alert.id).where(Alert.rule_id == rule.id)
    ).all()
    if alert_ids and session.scalar(
        select(MaintenanceRecord.id)
        .where(MaintenanceRecord.alert_id.in_(alert_ids))
        .limit(1)
    ):
        raise HTTPException(status_code=409,detail=(
                "This rule has maintenance records linked to its alerts. "
                "Remove those links before permanently deleting the rule."
            ),
        )

    deleted_name = rule.name
    deleted_asset_id = rule.target_asset_id
    event_references = [MonitoringEvent.rule_id == rule.id]
    if alert_ids:
        event_references.append(MonitoringEvent.alert_id.in_(alert_ids))
    session.execute(delete(MonitoringEvent).where(or_(*event_references)))
    if alert_ids:
        session.execute(delete(Alert).where(Alert.id.in_(alert_ids)))
    session.execute(delete(RuleState).where(RuleState.rule_id == rule.id))
    session.execute(delete(RuleCounterState).where(RuleCounterState.rule_id == rule.id))
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
    rows = session.execute(
        select(MaintenanceRecord, MonitoringRule.name)
        .outerjoin(Alert, Alert.id == MaintenanceRecord.alert_id)
        .outerjoin(MonitoringRule, MonitoringRule.id == Alert.rule_id)
        .where(MaintenanceRecord.asset_id == asset_id)
        .where(MaintenanceRecord.status == "completed")
        .order_by(MaintenanceRecord.performed_at.desc())
    ).all()
    return [
        {
            "id": record.id,
            "time": record.performed_at.isoformat(),
            "text": record.summary + (f" — {record.notes}" if record.notes else ""),
            "title": record.title,
            "summary": record.summary,
            "notes": record.notes,
            "maintenance_type": record.maintenance_type,
            "status": record.status,
            "alert_id": record.alert_id,
            "assigned_rule": rule_name,
            "assigned_technician": record.assigned_technician or record.performed_by,
            "priority": record.priority,
            "completion_notes": record.completion_notes,
            "parts_used": record.parts_used,
            "checklist": record.checklist,
            "actual_started_at": (
                record.actual_started_at.isoformat()
                if record.actual_started_at
                else None
            ),
            "actual_completed_at": (
                record.actual_completed_at.isoformat()
                if record.actual_completed_at
                else None
            ),
            "actual_duration_seconds": (
                max(
                    0,
                    int(
                        (
                            (
                                record.actual_completed_at.replace(tzinfo=timezone.utc)
                                if record.actual_completed_at.tzinfo is None
                                else record.actual_completed_at.astimezone(timezone.utc)
                            )
                            -
                            (
                                record.actual_started_at.replace(tzinfo=timezone.utc)
                                if record.actual_started_at.tzinfo is None
                                else record.actual_started_at.astimezone(timezone.utc)
                            )
                        ).total_seconds()
                    ),
                )
                if record.actual_started_at and record.actual_completed_at
                else None
            ),
            "planned_due_date": (
                record.planned_due_date.isoformat()
                if record.planned_due_date
                else None
            ),
            "planned_start_at": (
                record.planned_start_at.isoformat()
                if record.planned_start_at
                else None
            ),
            "planned_end_at": (
                record.planned_end_at.isoformat()
                if record.planned_end_at
                else None
            ),
        }
        for record, rule_name in rows
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
    events = session.execute(
        select(MonitoringEvent, Asset.name, MonitoringRule.name)
        .outerjoin(Asset, Asset.id == MonitoringEvent.asset_id)
        .outerjoin(MonitoringRule, MonitoringRule.id == MonitoringEvent.rule_id)
        .where(MonitoringEvent.asset_id == asset_id)
        .where(MonitoringEvent.rule_id.is_not(None))
        .where(~MonitoringEvent.event_type.like("maintenance_%"))
        .order_by(MonitoringEvent.occurred_at.desc(), MonitoringEvent.id.desc())
        .limit(200)
    ).all()
    return [
        {
            "id": event.id,
            "time": event.occurred_at.isoformat(),
            "event_type": event.event_type,
            "severity": event.severity,
            "text": event.message,
            "asset_id": event.asset_id,
            "asset_name": asset_name,
            "rule_id": event.rule_id,
            "rule_name": rule_name,
            "alert_id": event.alert_id,
            "metadata": event.event_metadata,
        }
        for event, asset_name, rule_name in events
    ]

#Rule Collections -> 
# List collections
@router.get("/collections")
def list_collections(session: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = session.scalars(select(RuleCollection).order_by(RuleCollection.id)).all()
    templates = session.scalars(
        select(MonitoringRuleTemplate)
        .where(MonitoringRuleTemplate.collection_id.is_not(None))
        .order_by(MonitoringRuleTemplate.name, MonitoringRuleTemplate.id)
    ).all()
    templates_by_collection: dict[int, list[dict[str, Any]]] = {}
    for template in templates:
        if template.collection_id is None:
            continue
        templates_by_collection.setdefault(template.collection_id, []).append(
            {"id": template.id, "name": template.name}
        )
    return [
        {
            "id": row.id,
            "name": row.name,
            "description": row.description,
            "rules": templates_by_collection.get(row.id, []),
            "rule_count": len(templates_by_collection.get(row.id, [])),
        }
        for row in rows
    ]

#Create a collecton
@router.post("/collections", status_code=201)
def create_collection(payload: CollectionCreate, session: Session = Depends(get_db)) -> dict[str, Any]:
    collection = RuleCollection(name=payload.name.strip(), description=payload.description)
    session.add(collection)
    try:
        session.flush()
        templates = [
            MonitoringRuleTemplate(
                **rule.model_dump(exclude={"collection_id"}),
                collection_id=collection.id,
            )
            for rule in (payload.rules or [])
        ]
        session.add_all(templates)
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=409, detail="A collection with this name already exists") from error
    session.refresh(collection)
    return {
        "id": collection.id,
        "name": collection.name,
        "description": collection.description,
        "rules": [{"id": item.id, "name": item.name} for item in templates],
        "rule_count": len(templates),
    }

#Delete a collection
@router.delete("/collections/{collection_id}", status_code=204)
def delete_collection(collection_id: int, session: Session = Depends(get_db)) -> None:
    collection = session.get(RuleCollection, collection_id)
    if collection is None:
        raise HTTPException(status_code=404, detail="Collection was not found")
    templates = session.scalars(
        select(MonitoringRuleTemplate).where(
            MonitoringRuleTemplate.collection_id == collection_id
        )
    ).all()
    for template in templates:
        template.collection_id = None
    session.delete(collection)
    session.commit()

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
            "labels": row.labels or [], "duration_minutes": row.duration_minutes,
            "files": [{"id": f.id, "name": f.original_name, "size_bytes": f.size_bytes,
                       "content_type": f.content_type,
                       "view_url": f"/api/v1/documents/{row.id}/files/{f.id}/view",
                       "download_url": f"/api/v1/documents/{row.id}/files/{f.id}/download"}
                      for f in attachments],
        })
    return result

#Creates a document
@router.post("/documents", status_code=201)
def create_document(payload: DocumentCreate, session: Session = Depends(get_db)) -> dict[str, Any]:
    document = InstructionDocument(
        title=payload.title.strip(),
        kind=payload.kind.strip(),
        description=payload.description,
        labels=[label.strip() for label in payload.labels if label.strip()],
        duration_minutes=payload.duration_minutes,
    )
    session.add(document)
    session.commit()
    session.refresh(document)
    return {"id": document.id, "title": document.title, "kind": document.kind,
            "description": document.description, "labels": document.labels,
            "duration_minutes": document.duration_minutes}

# Create a document and store multiple attachments in the backend uploads directory.
@router.post("/documents/with-files", status_code=201)
async def create_document_with_files(
    title: str = Form(...),
    kind: str = Form(...),
    description: str = Form(""),
    labels: str = Form("[]"),
    duration_minutes: int | None = Form(default=None, ge=1),
    files: list[UploadFile] = File(default=[]),
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    title, kind = title.strip(), kind.strip()
    if not title or not kind:
        raise HTTPException(status_code=422, detail="Title and type are required")
    if len(files) > MAX_FILES_PER_DOCUMENT:
        raise HTTPException(status_code=413, detail=f"Choose no more than {MAX_FILES_PER_DOCUMENT} files")
    try:
        parsed_labels = json.loads(labels)
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="Labels must be a JSON array") from error
    if (
        not isinstance(parsed_labels, list)
        or len(parsed_labels) > 10
        or any(not isinstance(label, str) or not label.strip() for label in parsed_labels)
    ):
        raise HTTPException(status_code=422, detail="Labels must contain up to 10 non-empty strings")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    saved_paths: list[Path] = []
    total = 0
    try:
        document = InstructionDocument(
            title=title,
            kind=kind,
            description=description.strip() or None,
            labels=[label.strip() for label in parsed_labels],
            duration_minutes=duration_minutes,
        )
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
        return {
            "id": document.id,
            "title": document.title,
            "kind": document.kind,
            "description": document.description,
            "labels": document.labels,
            "duration_minutes": document.duration_minutes,
            "file_count": len(saved_paths),
        }
    except Exception:
        session.rollback()
        for path in saved_paths:
            path.unlink(missing_ok=True)
        raise
    finally:
        for upload in files:
            await upload.close()


def _stored_instruction_file_path(attachment: InstructionDocumentFile) -> Path:
    stored_name = attachment.stored_name
    if (
        not stored_name
        or stored_name in {".", ".."}
        or "/" in stored_name
        or "\\" in stored_name
        or Path(stored_name).is_absolute()
        or bool(Path(stored_name).drive)
        or Path(stored_name).name != stored_name
    ):
        raise HTTPException(status_code=404, detail="Stored file is missing")

    upload_root = UPLOAD_DIR.resolve()
    try:
        path = (upload_root / stored_name).resolve(strict=True)
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=404, detail="Stored file is missing") from error
    if path.parent != upload_root or not path.is_file():
        raise HTTPException(status_code=404, detail="Stored file is missing")
    return path


@router.get("/documents/{document_id}/files/{file_id}/view")
def view_document_file(
    document_id: int,
    file_id: int,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    attachment = session.scalar(
        select(InstructionDocumentFile).where(
            InstructionDocumentFile.id == file_id,
            InstructionDocumentFile.document_id == document_id,
        )
    )
    if attachment is None:
        raise HTTPException(status_code=404, detail="Document attachment was not found")
    path = _stored_instruction_file_path(attachment)

    extension = Path(attachment.original_name).suffix.lower()
    if extension == ".docx":
        try:
            word_document = WordDocument(path)
        except (PackageNotFoundError, BadZipFile, KeyError, ValueError) as error:
            raise HTTPException(status_code=422, detail="Word document could not be previewed") from error
        paragraphs = "".join(
            f"<p>{escape(paragraph.text)}</p>"
            for paragraph in word_document.paragraphs
            if paragraph.text.strip()
        )
        tables = "".join(
            "<table>"
            + "".join(
                "<tr>" + "".join(f"<td>{escape(cell.text)}</td>" for cell in row.cells) + "</tr>"
                for row in table.rows
            )
            + "</table>"
            for table in word_document.tables
        )
        return HTMLResponse(
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{escape(attachment.original_name)}</title>"
            "<style>body{font:16px/1.6 system-ui,sans-serif;max-width:900px;"
            "margin:32px auto;padding:0 20px;color:#20242a}table{border-collapse:collapse}"
            "td{border:1px solid #aaa;padding:6px 10px}</style></head>"
            f"<body>{paragraphs}{tables}</body></html>",
            headers={"Content-Disposition": "inline"},
        )
    if extension == ".doc":
        return HTMLResponse(
            "<!doctype html><html><body><p>This legacy .doc file cannot be previewed "
            "in the browser. Please download the file to open it.</p></body></html>",
            headers={"Content-Disposition": "inline"},
        )
    if extension == ".txt":
        return FileResponse(
            path,
            media_type="text/plain; charset=utf-8",
            filename=attachment.original_name,
            content_disposition_type="inline",
        )
    if extension == ".pdf":
        return FileResponse(
            path,
            media_type="application/pdf",
            filename=attachment.original_name,
            content_disposition_type="inline",
        )
    raise HTTPException(status_code=415, detail="This document type cannot be previewed")


@router.get("/documents/{document_id}/files/{file_id}/download")
def download_document_file(
    document_id: int,
    file_id: int,
    session: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    attachment = session.scalar(select(InstructionDocumentFile).where(
        InstructionDocumentFile.id == file_id,
        InstructionDocumentFile.document_id == document_id,
    ))
    if attachment is None:
        raise HTTPException(status_code=404, detail="Document attachment was not found")
    path = _stored_instruction_file_path(attachment)
    media_type, _ = mimetypes.guess_type(attachment.original_name)
    return FileResponse(
        path,
        filename=attachment.original_name,
        media_type=media_type or "application/octet-stream",
        content_disposition_type="attachment",
    )


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
            configured_runtime_signal_mapping(request, data.variable_id),
            is_mapping_bypass_enabled(request),
        )
        rule_data = data.model_dump()
        rule_data["lifecycle_status"] = ("in_progress" if data.is_enabled else "deactivated")
        session.add(MonitoringRule(**rule_data))
    session.commit()
    return {"rules": len(rules), "collections": created}

@router.get("/me")
def get_profile(request: Request, session: Session = Depends(get_db)) -> dict[str, Any]:
    user_id = getattr(request.state, "auth_user_id", None)
    user = session.get(User, user_id) if user_id is not None else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Authentication required")
    return {
        "name": user.username,
        "username": user.username,
        "role": user.role,
        "is_active": user.is_active,
    }

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
    restore_backup(session, request.app.state.engine, request.app.state.settings, record.file_name)
    return {"status": "restored", "name": record.name}
