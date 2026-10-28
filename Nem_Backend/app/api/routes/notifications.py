# Administrator-managed asset supervisor assignments and notification status
#Handles three main functions: assigning supervisors to assets, sending a test email,summarizing email notification statuses
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.api.routes.auth import require_roles
from app.db.session import get_db
from app.models import Asset, AssetSupervisor, EmailNotification, User
from app.services.email_notifications import (
    SmtpConfigError,
    describe_smtp_error,
    send_test_email,
    valid_email,
)

router = APIRouter(tags=["notifications"], dependencies=[Depends(require_roles("Administrator"))])
Db = Annotated[Session, Depends(get_db)]
LOGGER = logging.getLogger("nem_backend.notifications")

#Accepts list of supervisor used IDs,with a maximum of 50 entries
class SupervisorAssignment(BaseModel):
    user_ids: list[int] = Field(default_factory=list, max_length=50)

#Validates the recipient`s email address before sending a test`
class TestEmailRequest(BaseModel):
    recipient: str = Field(min_length=1, max_length=254)

    @field_validator("recipient")
    @classmethod
    def validate_recipient(cls, value: str) -> str:
        value = value.strip()
        if not valid_email(value):
            raise ValueError("Enter a valid test recipient email address")
        return value

#Calls the SMTP service and returns an appropriate success or error response
@router.post("/notifications/email/test")
def send_email_test(payload: TestEmailRequest, request: Request, session: Db) -> dict[str, str]:
    try:
        send_test_email(session, request.app.state.settings, payload.recipient)
    except SmtpConfigError as error:
        LOGGER.warning("SMTP test email configuration failed: %s", str(error))
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        diagnostic = describe_smtp_error(error)
        LOGGER.warning("SMTP test email failed: %s", diagnostic)
        raise HTTPException(status_code=502, detail=diagnostic) from error

    LOGGER.info("SMTP test email was accepted by the configured server")
    return {
        "status": "accepted",
        "message": (
            "The SMTP server accepted the test message for delivery. "
            "Inbox receipt is not confirmed."
        ),
    }

#Retrives supervisors currently assigned to an asset
def _assignment(session: Session, asset_id: int) -> dict:
    users = session.scalars(
        select(User).join(AssetSupervisor, AssetSupervisor.user_id == User.id)
        .where(AssetSupervisor.asset_id == asset_id).order_by(User.username)
    ).all()
    return {
        "asset_id": asset_id,
        "supervisors": [
            {"id": u.id, "username": u.username, "email_address": u.email_address} for u in users
        ],
    }

# Returns an asset`s supervisor assignments.
@router.get("/assets/{asset_id}/supervisors")
def get_asset_supervisors(asset_id: int, session: Db) -> dict:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    return _assignment(session, asset_id)

# Replaces an asset`s supervisor assignments after validating the selected users.
@router.put("/assets/{asset_id}/supervisors")
def set_asset_supervisors(asset_id: int, payload: SupervisorAssignment, session: Db) -> dict:
    if session.get(Asset, asset_id) is None:
        raise HTTPException(status_code=404, detail=f"Asset {asset_id} was not found")
    user_ids = sorted(set(payload.user_ids))
    if user_ids:
        valid = set(session.scalars(
            select(User.id).where(User.id.in_(user_ids), User.role == "Supervisor", User.is_active.is_(True))
        ).all())
        invalid = [i for i in user_ids if i not in valid]
        if invalid:
            raise HTTPException(status_code=422, detail=f"Not active Supervisor accounts: {invalid}")
    session.execute(delete(AssetSupervisor).where(AssetSupervisor.asset_id == asset_id))
    session.add_all(AssetSupervisor(asset_id=asset_id, user_id=i) for i in user_ids)
    session.commit()
    return _assignment(session, asset_id)

#Counts notifications by status and returns up to five recent errors
@router.get("/notifications/email/summary")
def email_notification_summary(session: Db) -> dict:
    rows = session.execute(
        select(EmailNotification.status, func.count()).group_by(EmailNotification.status)
    ).all()
    recent_errors = session.scalars(
        select(EmailNotification.last_error)
        .where(EmailNotification.last_error.is_not(None))
        .order_by(EmailNotification.id.desc()).limit(5)
    ).all()
    return {"counts": {status: count for status, count in rows}, "recent_errors": recent_errors}