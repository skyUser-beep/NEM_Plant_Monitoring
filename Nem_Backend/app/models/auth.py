"""Local users and revocable login sessions."""
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.base import Base
from app.db.session import UTCDateTime

#Stores user accounts 
class User(Base):
    __tablename__ = "auth_users"
    __table_args__ = (
        CheckConstraint("role IN ('Administrator', 'Supervisor', 'Operator')",name="ck_auth_users_role",),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="Supervisor", index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    contact_number: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    email_address: Mapped[Optional[str]] = mapped_column(String(254), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=lambda: datetime.now(timezone.utc))
    sessions: Mapped[list["AuthSession"]] = relationship(back_populates="user", cascade="all, delete-orphan")

#Manages login sessions
class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("auth_users.id", ondelete="CASCADE"), index=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column( UTCDateTime(), nullable=False, default=lambda: datetime.now(timezone.utc))
    user: Mapped[User] = relationship(back_populates="sessions")
