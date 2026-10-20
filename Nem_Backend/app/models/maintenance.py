from datetime import date, datetime, timezone
from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base
from app.db.session import UTCDateTime

#represents the recurring maintenance plan
class MaintenanceSchedule(Base):
    __tablename__ = "nem_maintenance_schedules"
    __table_args__ = (
        CheckConstraint(
            "recurrence_unit IS NULL OR recurrence_unit IN ('days', 'weeks', 'months', 'years')",
            name="ck_maintenance_schedule_recurrence_unit",
        ),
        CheckConstraint(
            "recurrence_interval IS NULL OR recurrence_interval > 0",
            name="ck_maintenance_schedule_recurrence_interval",
        ),
        Index(
            "ix_maintenance_schedule_asset_status_due",
            "asset_id",
            "status",
            "current_due_date",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(
        ForeignKey("assets.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    maintenance_type: Mapped[str] = mapped_column(String(30), nullable=False)
    priority: Mapped[str] = mapped_column(String(20), nullable=False)
    assigned_technician: Mapped[str | None] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text)
    schedule_start_date: Mapped[date] = mapped_column(Date, nullable=False)
    current_period_start_date: Mapped[date] = mapped_column(Date, nullable=False)
    first_due_date: Mapped[date] = mapped_column(Date, nullable=False)
    current_due_date: Mapped[date | None] = mapped_column(Date)
    proposed_due_date: Mapped[date | None] = mapped_column(Date)
    current_occurrence_id: Mapped[int | None] = mapped_column(Integer)
    recurrence_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("FALSE")
    )
    recurrence_interval: Mapped[int | None] = mapped_column(Integer)
    recurrence_unit: Mapped[str | None] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", server_default=text("'active'")
    )
    approval_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="not_required", server_default=text("'not_required'")
    )
    last_completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    due_alerted_for: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


#stores the maintenance work performed on machines 
class MaintenanceRecord(Base):
    __tablename__ = "nem_maintenance_records"
    __table_args__ = (
        Index("ix_nem_maintenance_records_asset_performed", "asset_id", "performed_at"),
        UniqueConstraint(
            "schedule_id",
            "planned_due_date",
            name="uq_maintenance_occurrence_schedule_due",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=False, index=True)
    alert_id: Mapped[int | None] = mapped_column(ForeignKey("nem_alerts.id", ondelete="RESTRICT"), index=True)
    summary: Mapped[str] = mapped_column(String(200), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    performed_by: Mapped[str] = mapped_column(String(200), nullable=False)
    performed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    next_due_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    maintenance_type: Mapped[str] = mapped_column(
        String(30), nullable=False, default="inspection", server_default=text("'inspection'")
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="completed", server_default=text("'completed'")
    )
    planned_start_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    planned_end_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    actual_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    actual_completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    priority: Mapped[str] = mapped_column(
        String(20), nullable=False, default="medium", server_default=text("'medium'")
    )
    assigned_technician: Mapped[str | None] = mapped_column(String(200))
    completion_notes: Mapped[str | None] = mapped_column(Text)
    parts_used: Mapped[str | None] = mapped_column(Text)
    checklist: Mapped[list[dict[str, object]] | None] = mapped_column(JSON)
    schedule_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_maintenance_schedules.id", ondelete="RESTRICT"), index=True
    )
    planned_due_date: Mapped[date | None] = mapped_column(Date)
    archived_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)

    @property
    def title(self) -> str:
        return self.summary
