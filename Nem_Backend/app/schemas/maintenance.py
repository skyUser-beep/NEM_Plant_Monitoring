#Pydantic schemas for maintenance records and recurring maintenance schedules

from datetime import date, datetime, timezone
from typing import Any, Literal #restrict a field to specific permitted values
from pydantic import ConfigDict, Field, field_validator, model_validator
from app.schemas.common import ORMModel

#Creates an individual maintenance record
class MaintenanceCreate(ORMModel):
    asset_id: int = Field(gt=0)
    alert_id: int | None = Field(default=None, gt=0)
    summary: str | None = Field(default=None, min_length=1, max_length=200)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    notes: str | None = Field(default=None, max_length=10_000)
    performed_by: str | None = Field(default=None, min_length=1, max_length=200)
    performed_at: datetime | None = None
    next_due_at: datetime | None = None
    due_date: date | None = None
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"] = "inspection"
    status: Literal["planned", "in_progress", "completed", "cancelled"] = "planned"
    planned_start_at: datetime | None = None
    planned_end_at: datetime | None = None
    actual_started_at: datetime | None = None
    actual_completed_at: datetime | None = None
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    assigned_technician: str | None = Field(default=None, max_length=200)
    completion_notes: str | None = Field(default=None, max_length=10_000)
    parts_used: str | None = Field(default=None, max_length=10_000)
    checklist: list[dict[str, object]] | None = None

    @field_validator("summary", "title", "performed_by", "assigned_technician")
    @classmethod
    def strip_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        return stripped

    @field_validator(
        "performed_at",
        "next_due_at",
        "planned_start_at",
        "planned_end_at",
        "actual_started_at",
        "actual_completed_at",
    )
    @classmethod
    def normalize_timestamp(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

#Schema checks that the planned end is not earlier than the planned start
    @model_validator(mode="after")
    def validate_dates(self):
        if self.title is not None:
            if self.planned_start_at is None or self.planned_end_at is None:
                raise ValueError("planned_start_at and planned_end_at are required")
            if self.planned_end_at < self.planned_start_at:
                raise ValueError("planned_end_at must not precede planned_start_at")
            if self.notes is None or not self.notes.strip():
                raise ValueError("notes are required for a maintenance job")
        elif self.summary is None or self.performed_by is None:
            raise ValueError("Provide a title or a legacy summary and performed_by")

        if (
            self.actual_started_at is not None
            and self.actual_completed_at is not None
            and self.actual_completed_at < self.actual_started_at
        ):
            raise ValueError("actual_completed_at must not precede actual_started_at")
        if (
            self.performed_at is not None
            and self.next_due_at is not None
            and self.next_due_at <= self.performed_at
        ):
            raise ValueError("next_due_at must be later than performed_at")
        return self

# Defines the data returned for a maintenance record
#Data that backend returns to the frontend when a maintenance record is requested
class MaintenanceRead(ORMModel):
    id: int
    asset_id: int
    alert_id: int | None
    summary: str
    title: str
    notes: str | None
    performed_by: str
    performed_at: datetime
    next_due_at: datetime | None
    maintenance_type: str
    status: str
    planned_start_at: datetime | None
    planned_end_at: datetime | None
    actual_started_at: datetime | None
    actual_completed_at: datetime | None
    priority: str
    assigned_technician: str | None
    completion_notes: str | None
    parts_used: str | None
    checklist: list[dict[str, object]] | None
    schedule_id: int | None = None
    planned_due_date: date | None = None
    archived_at: datetime | None = None
    created_at: datetime

#Defines which maintenance record fields can be updated,editing a job
class MaintenanceUpdate(ORMModel):
    model_config = ConfigDict(extra="forbid")

    alert_id: int | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"] | None = None
    planned_start_at: datetime | None = None
    planned_end_at: datetime | None = None
    actual_started_at: datetime | None = None
    actual_completed_at: datetime | None = None
    priority: Literal["low", "medium", "high", "critical"] | None = None
    assigned_technician: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=10_000)
    completion_notes: str | None = Field(default=None, max_length=10_000)
    parts_used: str | None = Field(default=None, max_length=10_000)
    checklist: list[dict[str, object]] | None = None
    next_due_at: datetime | None = None

    @field_validator("title", "assigned_technician")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Text fields cannot be empty")
        return value

    @field_validator(
        "planned_start_at",
        "planned_end_at",
        "actual_started_at",
        "actual_completed_at",
        "next_due_at",
    )
    @classmethod
    def normalize_timestamp(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

#Create a maintenance schedule,including recurrence settings
#The core of recurring maintenance
class MaintenanceScheduleCreate(ORMModel):
    asset_id: int = Field(gt=0)
    title: str = Field(min_length=1, max_length=200)
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"]
    priority: Literal["low", "medium", "high", "critical"] = "medium"
    assigned_technician: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=10_000)
    schedule_start_date: date
    first_due_date: date
    recurrence_enabled: bool = False
    recurrence_interval: int | None = Field(default=None, ge=1, le=3650)
    recurrence_unit: Literal["days", "weeks", "months", "years"] | None = None
    instruction_document_ids: list[int] = Field(default_factory=list, max_length=100)

    @field_validator("title", "assigned_technician")
    @classmethod
    def clean_schedule_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Text fields cannot be empty")
        return cleaned
    @model_validator(mode="after")
    def validate_schedule(self):
        if self.first_due_date < self.schedule_start_date:
            raise ValueError("first_due_date must not precede schedule_start_date")
        if self.recurrence_enabled and (self.recurrence_interval is None or self.recurrence_unit is None):
            raise ValueError("recurrence_interval and recurrence_unit are required for recurring schedules")
        if not self.recurrence_enabled and (self.recurrence_interval is not None or self.recurrence_unit is not None):
            raise ValueError("recurrence settings require recurrence_enabled=true")
        return self

#Updates an existing schedule, modifying an existing schedule.
class MaintenanceScheduleUpdate(ORMModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=200)
    maintenance_type: Literal["preventive", "corrective", "inspection", "unplanned"] | None = None
    priority: Literal["low", "medium", "high", "critical"] | None = None
    assigned_technician: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=10_000)
    schedule_start_date: date | None = None
    first_due_date: date | None = None
    recurrence_enabled: bool | None = None
    recurrence_interval: int | None = Field(default=None, ge=1, le=3650)
    recurrence_unit: Literal["days", "weeks", "months", "years"] | None = None
    instruction_document_ids: list[int] | None = Field(default=None, max_length=100)
    status: Literal["active", "paused", "cancelled", "awaiting_approval", "completed"] | None = None

    @field_validator("title", "assigned_technician")
    @classmethod
    def clean_optional_schedule_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Text fields cannot be empty")
        return cleaned

    @model_validator(mode="after")
    def validate_schedule_update(self):
        if self.schedule_start_date and self.first_due_date:
            if self.first_due_date < self.schedule_start_date:
                raise ValueError("first_due_date must not precede schedule_start_date")
        return self

#Returns schedule information , including due status and approval status, displaying the schedule
class MaintenanceScheduleRead(ORMModel):
    id: int
    asset_id: int
    title: str
    maintenance_type: str
    priority: str
    assigned_technician: str | None
    description: str | None
    instruction_document_ids: list[int]
    instruction_documents: list[dict[str, Any]]
    schedule_start_date: date
    current_period_start_date: date
    first_due_date: date
    current_due_date: date | None
    proposed_due_date: date | None
    current_occurrence_id: int | None
    recurrence_enabled: bool
    recurrence_interval: int | None
    recurrence_unit: str | None
    status: str
    approval_status: str
    last_completed_at: datetime | None
    due_status: str
    current_day_count: int
    total_days: int
    created_at: datetime
    updated_at: datetime

#Accepts a due date when confirming the next schedule - user approval
class MaintenanceScheduleConfirm(ORMModel):
    due_date: date

#Create Schedule -> Monitor the due data -> Complete maintenance -> Propose next due date -> Save approved next occurrence
