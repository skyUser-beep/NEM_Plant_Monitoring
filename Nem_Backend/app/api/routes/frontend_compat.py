
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from typing import Any

from cryptography.fernet import Fernet # encrypts and decrypts sensitive values, such as a saved email password
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, ValidationError, field_validator 
from sqlalchemy import select
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
from app.schemas.rule import RuleCreate
from app.services.frontend_backup import create_backup, restore_backup
from app.services.monitoring_engine import (
    emit_event,
    resolve_active_rule_alerts,
    set_rule_enabled_state,
)
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
        raise HTTPException(
            status_code=503,
            detail="Email password encryption is not configured; set SETTINGS_ENCRYPTION_KEY in the backend environment.",
        )
    try:
        return Fernet(value.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise HTTPException(
            status_code=503, detail="SETTINGS_ENCRYPTION_KEY must be a valid Fernet key."
        ) from error

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
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")

    rule = MonitoringRule(
        name=payload.name,
        description=payload.description,
        rule_type="generic",
        target_asset_id=asset_id,
        variable_id=None,
        operator=None,
        threshold=None,
        parameters={"kind": "usage_based", "usage_limit": payload.usage_limit},
        severity=payload.severity,
        is_enabled=True,
    )
    session.add(rule)
    session.commit()
    session.refresh(rule)
    return _rule_row(session, rule)


@router.post("/assets/{asset_id}/rules/time", status_code=201)
def frontend_create_time_rule(
    asset_id: int,
    payload: TimeRuleCreate,
    session: Session = Depends(get_db),
) -> dict[str, Any]:
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")

    rule = MonitoringRule(
        name=payload.name,
        description=payload.description,
        rule_type="generic",
        target_asset_id=asset_id,
        variable_id=None,
        operator=None,
        threshold=None,
        parameters={
            "kind": "time_based",
            "current_time": payload.current_time.isoformat(),
            "end_time": payload.end_time.isoformat(),
        },
        severity=payload.severity,
        is_enabled=True,
    )
    session.add(rule)
    session.commit()
    session.refresh(rule)
    return _rule_row(session, rule)


@router.post("/assets/{asset_id}/rules/bulk")
def frontend_bulk_rule_state(
    asset_id: int,
    payload: dict[str, str],
    session: Session = Depends(get_db),
) -> dict[str, int]:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    state = payload.get("state")
    if state not in {"activated", "not_activated"}:
        raise HTTPException(status_code=422, detail="State must be activated or not_activated")
    rules = session.scalars(
        select(MonitoringRule).where(
            MonitoringRule.target_asset_id == asset_id,
            MonitoringRule.is_archived.is_(False),
        )
    ).all()
    enabled = state == "activated"
    for rule in rules:
        if rule.is_enabled != enabled:
            #uses the existing service and commits the changes
            set_rule_enabled_state(session, rule, enabled)
    session.commit()
    return {"updated": len(rules)}

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
