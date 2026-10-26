from datetime import datetime, timezone
from typing import Any
from sqlalchemy import ForeignKey, Index, JSON, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base
from app.db.session import UTCDateTime

#Reading data model -> stores individual readings collected from machines
class Reading(Base):
    __tablename__ = "nem_readings"
    __table_args__ = (
        Index("ix_nem_readings_variable_recorded", "variable_id", "recorded_at"),
        Index("ix_nem_readings_asset_recorded", "asset_id", "recorded_at"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    asset_id: Mapped[int] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=False, index=True)
    variable_id: Mapped[int] = mapped_column(ForeignKey("variables.id", ondelete="RESTRICT"), nullable=False, index=True)
    value: Mapped[Any] = mapped_column(JSON, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=lambda: datetime.now(timezone.utc), nullable=False, index=True)
    source_id: Mapped[str | None] = mapped_column(String(200))
    metadata_json: Mapped[dict[str, Any] | None] = mapped_column("metadata", JSON)
    variable: Mapped["Variable"] = relationship() # type: ignore

'''
    Asset tells the system which machine it is monitoring. 
    Variable tells it which signal on that machine it cares about. 
    Reading stores the values received from that signal over time.
    '''