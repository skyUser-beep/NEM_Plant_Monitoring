
# Reusable monitoring rule templates, separate from asset-specific rules.

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    ForeignKey,
    Index,
    JSON,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.session import UTCDateTime


class MonitoringRuleTemplate(Base):
    __tablename__ = "nem_monitoring_rule_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    required_variable_types: Mapped[list[str] | None] = mapped_column(JSON)
    variable_key: Mapped[str | None] = mapped_column(String(200))
    operator: Mapped[str | None] = mapped_column(String(10))
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    parameters: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    evaluation_interval_seconds: Mapped[int | None] = mapped_column()
    stale_after_seconds: Mapped[int | None] = mapped_column()

    collection_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_collections.id", ondelete="SET NULL"),
        index=True,
    )
    legacy_rule_id: Mapped[int | None] = mapped_column(unique=True)

    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class MonitoringRuleTemplateRequest(Base):
    """Supervisor-submitted reusable rule awaiting Admin review."""

    __tablename__ = "nem_monitoring_rule_template_requests"

    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'approved', 'declined')",
            name="ck_nem_rule_template_requests_status",
        ),
        Index(
            "ix_nem_rule_template_requests_status_created",
            "status",
            "created_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    # Proposed reusable rule configuration.
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(40), nullable=False)
    required_variable_types: Mapped[list[str] | None] = mapped_column(JSON)
    variable_key: Mapped[str | None] = mapped_column(String(200))
    operator: Mapped[str | None] = mapped_column(String(10))
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    parameters: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False
    )
    evaluation_interval_seconds: Mapped[int | None] = mapped_column()
    stale_after_seconds: Mapped[int | None] = mapped_column()

    # Optional collection selected for the proposed template.
    collection_id: Mapped[int | None] = mapped_column(
        ForeignKey("rule_collections.id", ondelete="SET NULL"),
        index=True,
    )

    # Requester and reviewer reference existing users.
    requested_by: Mapped[int] = mapped_column(
        ForeignKey("auth_users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        default="pending",
        server_default="pending",
        nullable=False,
        index=True,
    )
    reviewed_by: Mapped[int | None] = mapped_column(
        ForeignKey("auth_users.id", ondelete="RESTRICT"),
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    review_comment: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

class MonitoringRule(Base):
    """Asset-specific monitoring rule."""

    __tablename__ = "nem_monitoring_rules"

    __table_args__ = (
        CheckConstraint(
            "severity IN ('warning', 'alert')",
            name="ck_nem_monitoring_rules_severity",
        ),
        CheckConstraint(
            "lifecycle_status IN "
            "('in_progress', 'suspended', 'deactivated', 'completed')",
            name="ck_nem_monitoring_rules_lifecycle_status",
        ),
        CheckConstraint(
            "rule_type IN "
            "('parameter_threshold', 'runtime_duration', 'duration', "
            "'generic', 'boolean_condition', 'boolean_count_threshold')",
            name="ck_nem_monitoring_rules_type",
        ),
        Index(
            "ix_nem_monitoring_rules_target_enabled",
            "target_asset_id",
            "is_enabled",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)

    target_asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("assets.id", ondelete="RESTRICT"),
        index=True,
    )
    source_template_id: Mapped[int | None] = mapped_column(
        ForeignKey(
            "nem_monitoring_rule_templates.id",
            ondelete="RESTRICT",
        ),
        index=True,
    )
    variable_id: Mapped[int | None] = mapped_column(
        ForeignKey("variables.id", ondelete="RESTRICT"),
        index=True,
    )

    operator: Mapped[str | None] = mapped_column(String(10))
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))
    parameters: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)

    is_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False, index=True
    )
    is_archived: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default=text("false"),
        nullable=False,
    )
    lifecycle_status: Mapped[str] = mapped_column(
        String(20),
        default="in_progress",
        server_default="in_progress",
        nullable=False,
    )
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    evaluation_interval_seconds: Mapped[int | None] = mapped_column()
    stale_after_seconds: Mapped[int | None] = mapped_column()

    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


# Stores the current result of a monitoring rule.
class RuleState(Base):
    __tablename__ = "nem_rule_states"

    __table_args__ = (
        CheckConstraint(
            "status IN ('normal', 'warning', 'alert', 'unknown')",
            name="ck_nem_rule_states_status",
        ),
        Index("ix_nem_rule_states_status", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(
        ForeignKey("nem_monitoring_rules.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    target_asset_id: Mapped[int] = mapped_column(
        ForeignKey("assets.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    target_variable_id: Mapped[int | None] = mapped_column(
        ForeignKey("variables.id", ondelete="RESTRICT"),
        index=True,
    )

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="unknown"
    )
    latest_value: Mapped[Any | None] = mapped_column(JSON)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    last_evaluated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False
    )
    condition_started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_transition_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False
    )
    error_message: Mapped[str | None] = mapped_column(Text)


# Stores problems that need attention.
class Alert(Base):
    __tablename__ = "nem_alerts"

    __table_args__ = (
        CheckConstraint(
            "severity IN ('warning', 'alert')",
            name="ck_nem_alerts_severity",
        ),
        CheckConstraint(
            "status IN ('active', 'resolved')",
            name="ck_nem_alerts_status",
        ),
        Index(
            "ix_nem_alerts_active_asset_severity",
            "status",
            "target_asset_id",
            "severity",
        ),
        Index(
            "ix_nem_alerts_rule_status",
            "rule_id",
            "status",
        ),
        Index(
            "uq_nem_alerts_active_rule_asset",
            "rule_id",
            "target_asset_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
        Index(
            "uq_nem_alerts_active_maintenance_due",
            "maintenance_schedule_id",
            "maintenance_due_date",
            unique=True,
            postgresql_where=text(
                "status = 'active' AND maintenance_schedule_id IS NOT NULL"
            ),
        ),
        CheckConstraint(
            "(rule_id IS NOT NULL AND maintenance_schedule_id IS NULL) OR "
            "(rule_id IS NULL AND maintenance_schedule_id IS NOT NULL "
            "AND maintenance_due_date IS NOT NULL)",
            name="ck_nem_alerts_source",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    rule_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_monitoring_rules.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    maintenance_schedule_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_maintenance_schedules.id", ondelete="RESTRICT"),
        index=True,
    )
    maintenance_due_date: Mapped[date | None] = mapped_column(Date)

    target_asset_id: Mapped[int] = mapped_column(
        ForeignKey("assets.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    target_variable_id: Mapped[int | None] = mapped_column(
        ForeignKey("variables.id", ondelete="RESTRICT"),
        index=True,
    )

    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(250), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    trigger_value: Mapped[Any | None] = mapped_column(JSON)
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(20, 6))

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active"
    )
    started_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False
    )
    last_updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    acknowledged_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    acknowledged_by: Mapped[str | None] = mapped_column(String(200))


# Stores monitoring event history.
class MonitoringEvent(Base):
    __tablename__ = "nem_monitoring_events"

    __table_args__ = (
        Index(
            "ix_nem_monitoring_events_asset_timestamp",
            "asset_id",
            "occurred_at",
        ),
        Index(
            "ix_nem_monitoring_events_type_timestamp",
            "event_type",
            "occurred_at",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_type: Mapped[str] = mapped_column(
        String(50), nullable=False, index=True
    )
    severity: Mapped[str | None] = mapped_column(String(20))

    asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("assets.id", ondelete="RESTRICT"),
        index=True,
    )
    rule_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_monitoring_rules.id", ondelete="RESTRICT"),
        index=True,
    )
    alert_id: Mapped[int | None] = mapped_column(
        ForeignKey("nem_alerts.id", ondelete="RESTRICT"),
        index=True,
    )

    message: Mapped[str] = mapped_column(Text, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False
    )
    event_metadata: Mapped[dict[str, Any] | None] = mapped_column(
        "metadata", JSON
    )


# A lease is a temporary claim to perform scheduled work.
class SchedulerLease(Base):
    __tablename__ = "scheduler_leases"

    name: Mapped[str] = mapped_column(String(100), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(100), nullable=False)
    lease_until: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), nullable=False
    )
