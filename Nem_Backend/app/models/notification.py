# Supervisor assignments and the persistent email notification outbox.
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import ForeignKey, Index, JSON, String, Text, UniqueConstraint, CheckConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.session import UTCDateTime

#This table stores which supervisors are directly assigned to which assets.
class AssetSupervisor(Base):
    #Supervisor assignment applies directly and is inherited by every descendant asset.
    __tablename__ = "nem_asset_supervisors"
    __table_args__ = (UniqueConstraint("asset_id", "user_id", name="uq_nem_asset_supervisors"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("auth_users.id", ondelete="CASCADE"), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)

#it stores email jobs so that they can be retried instead of relying on an email being sent immediately when an alert occurs.
class EmailNotification(Base):
    #One outbox row per (alert, severity, recipient); the unique key prevents duplicate emails.
    __tablename__ = "nem_email_notifications"
    __table_args__ = (
        UniqueConstraint("alert_id", "severity", "user_id", name="uq_nem_email_notification_event"),
        CheckConstraint(
            "status IN ('pending', 'sent', 'failed', 'skipped')",
            name="ck_nem_email_notifications_status",
        ),
        Index("ix_nem_email_notifications_due", "status", "next_attempt_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    alert_id: Mapped[int] = mapped_column(ForeignKey("nem_alerts.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("auth_users.id", ondelete="CASCADE"), index=True, nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(nullable=False, default=0)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
