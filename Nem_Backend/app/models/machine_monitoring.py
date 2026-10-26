from datetime import datetime
from decimal import Decimal
from sqlalchemy import Boolean, ForeignKey, Integer, Numeric, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base
from app.db.session import UTCDateTime

#create the db table 
class MachineMonitoringState(Base):
    __tablename__ = "machine_monitoring_states"

    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), primary_key=True)
    cycle_count: Mapped[int] = mapped_column(default=0, nullable=False)
    accumulated_running_seconds: Mapped[Decimal] = mapped_column( Numeric(20, 3), default=0, nullable=False)
    cycle_signal: Mapped[bool | None] = mapped_column(nullable=True)
    is_running: Mapped[bool | None] = mapped_column(nullable=True)
    cycle_limit: Mapped[int | None] = mapped_column(nullable=True)
    runtime_limit_seconds: Mapped[int | None] = mapped_column(nullable=True)
    last_cycle_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_cycle_signal_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_running_signal_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    runtime_checkpoint_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)


class RuleCounterState(Base):
    __tablename__ = "nem_rule_counter_states"
    __table_args__ = (UniqueConstraint("rule_id", "asset_id", name="uq_rule_counter_rule_asset"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int] = mapped_column(
        ForeignKey("nem_monitoring_rules.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=False, index=True)
    cycle_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cycle_signal: Mapped[bool | None] = mapped_column(Boolean)
    accumulated_running_seconds: Mapped[Decimal] = mapped_column( Numeric(20, 3), default=0, nullable=False)
    is_running: Mapped[bool | None] = mapped_column(Boolean)
    last_signal_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    runtime_checkpoint_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
