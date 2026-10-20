
from sqlalchemy import JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class MaintenanceInstruction(Base):
    __tablename__ = "maintenance_instructions"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    labels: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    duration_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=30
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
