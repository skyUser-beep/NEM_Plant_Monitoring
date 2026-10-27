# Local login, session management, and administrator account controls.
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import re

from app.db.session import get_db
from app.models import AuthSession, User
from app.services.auth_security import (
    hash_password,
    hash_session_token,
    new_session_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["authentication"])
SESSION_HOURS = 8
ROLES = ("Administrator", "Supervisor", "Operator")
_DUMMY_PASSWORD_HASH = ("pbkdf2_sha256$600000$00000000000000000000000000000000$"
    "0000000000000000000000000000000000000000000000000000000000000000"
)
#Login request -> when user logs in , the request must contains a username and password.
class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=1024)

#succefully login -> frontend receives session toekn, token type, and  when the session expires and user details
class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer" # Possession of the token is sufficient for auth ,without additional credentials
    expires_at: datetime
    user: dict

_INDIAN_PHONE_REGEX = re.compile(r"^(\+91|91|0)?[6-9]\d{9}$")
_EMAIL_REGEX = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _normalize_phone(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if digits.startswith("91") and len(digits) == 12:
        return digits[2:]
    if digits.startswith("0") and len(digits) == 11:
        return digits[1:]
    return digits


def _validate_phone(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if not _INDIAN_PHONE_REGEX.match(trimmed):
        raise ValueError(
            "Invalid phone number. Enter a valid 10-digit Indian mobile number "
            "(optionally prefixed with +91)."
        )
    return _normalize_phone(trimmed)


def _validate_email(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if not _EMAIL_REGEX.match(trimmed):
        raise ValueError(
            "Invalid email address. Use a valid format such as name@domain.com."
        )
    return trimmed


#This model controls account creation
class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=12, max_length=1024)
    role: Literal["Administrator", "Supervisor", "Operator"] = "Supervisor"
    contact_number: str | None = Field(default=None, max_length=20)
    email_address: str | None = Field(default=None, max_length=254)

    @field_validator("contact_number")
    @classmethod
    def validate_contact_number(cls, value: str | None) -> str | None:
        return _validate_phone(value)

    @field_validator("email_address")
    @classmethod
    def validate_email_address(cls, value: str | None) -> str | None:
        return _validate_email(value)

#Username normalization to case-insensitive form.
    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        value = value.strip().casefold()
        if not value:
            raise ValueError("Username cannot be empty")
        return value
#This model allow administrator to change a user`s role,active status, contact details or password`
class UserUpdate(BaseModel):
    role: Literal["Administrator", "Supervisor", "Operator"] | None = None
    is_active: bool | None = None
    contact_number: str | None = Field(default=None, max_length=20)
    email_address: str | None = Field(default=None, max_length=254)
    password: str | None = Field(default=None, min_length=12, max_length=1024)

    @field_validator("contact_number")
    @classmethod
    def validate_contact_number(cls, value: str | None) -> str | None:
        return _validate_phone(value)

    @field_validator("email_address")
    @classmethod
    def validate_email_address(cls, value: str | None) -> str | None:
        return _validate_email(value)


#DB Session dependency -> shortcut for asking FASTAPI to provide SQLAlchemy db session
Db = Annotated[Session, Depends(get_db)]

#Building the user response  -> func converts a db user object into a dictionary suitable for an API response 
def _user_read(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "is_active": user.is_active,
        "contact_number": user.contact_number,
        "email_address": user.email_address,
    }

#Identifying the loggin-in user  
async def get_current_user(request: Request, db: Db) -> User:
    user_id = getattr(request.state, "auth_user_id", None)
    if user_id is None:
        raise HTTPException(status_code=401,detail="Authentication required",headers={"WWW-Authenticate": "Bearer"},)
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Session is invalid or expired")
    return user

#Controlling what each role can do 
def require_roles(*roles: str):
    async def check_role(user: Annotated[User, Depends(get_current_user)]) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return check_role

#Login endpoint  -> authenticates a user and create a session
@router.post("/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Db) -> LoginResponse:
    #Normalize the username 
    username = payload.username.strip().casefold()
    user = db.scalar(select(User).where(User.username == username))
    password_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
    #Verify the password 
    password_is_valid = verify_password(payload.password, password_hash)
    if (
        user is None
        or not user.is_active
        or not password_is_valid
    ):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,detail="Invalid username or password",headers={"WWW-Authenticate": "Bearer"},)
#Generate a session token 
    token = new_session_token()
    expires = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)
    #Store the session
    db.add(AuthSession(
            user_id=user.id,
            token_hash=hash_session_token(token),
            expires_at=expires,
        )
    )
    db.commit()
    return LoginResponse(access_token=token,
        expires_at=expires,
        user=_user_read(user),
    )

#Current user endpoint
@router.get("/me")
async def me(user: Annotated[User, Depends(get_current_user)], db: Db) -> dict:
    return _user_read(user)

#Logout endpoint 
@router.post("/logout", status_code=204)
def logout(request: Request, db: Db) -> None:
    token = getattr(request.state, "auth_token_hash", None)
    if token:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == token))
        db.commit()

#List accounts 
@router.get("/users", dependencies=[Depends(require_roles("Administrator"))])
def list_users(db: Db) -> list[dict]:
    users = db.scalars(select(User).order_by(User.username)).all()
    return [_user_read(user) for user in users]

#Create account 
@router.post("/users", status_code=201, dependencies=[Depends(require_roles("Administrator"))])
def create_user(payload: UserCreate, db: Db) -> dict:
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        contact_number=payload.contact_number,
        email_address=payload.email_address,
        is_active=True,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="Username already exists") from error
    db.refresh(user)
    return _user_read(user)

#Updating a user account
@router.patch("/users/{user_id}", dependencies=[Depends(require_roles("Administrator"))])
def update_user(user_id: int, payload: UserUpdate, db: Db) -> dict:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User was not found")
    values = payload.model_dump(exclude_unset=True)
    if not values:
        return _user_read(user)
    if any(value is None for value in values.values()):
        raise HTTPException(status_code=422, detail="User update values cannot be null")
    removing_admin = user.role == "Administrator" and (
        values.get("role", user.role) != "Administrator"
        or values.get("is_active", user.is_active) is False
    )
    if removing_admin:
        active_admin_count = db.scalar(
            select(User.id).where(User.role == "Administrator", User.is_active.is_(True), User.id != user.id).limit(1)
        )
        if active_admin_count is None:
            raise HTTPException(status_code=409, detail="The last active administrator cannot be removed")
    role_or_password_changed = "role" in values or "password" in values
    if "password" in values:
        values["password_hash"] = hash_password(values.pop("password"))
    for field, value in values.items():
        setattr(user, field, value)
    if role_or_password_changed or user.is_active is False:
        db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.commit()
    db.refresh(user)
    return _user_read(user)

#Deleting a user account -> removes the user and all their sessions so they can no longer log in
@router.delete("/users/{user_id}", status_code=204, dependencies=[Depends(require_roles("Administrator"))])
def delete_user(user_id: int, db: Db) -> None:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User was not found")
    if user.role == "Administrator":
        active_admin_count = db.scalar(
            select(User.id).where(User.role == "Administrator", User.is_active.is_(True), User.id != user_id).limit(1)
        )
        if active_admin_count is None:
            raise HTTPException(status_code=409, detail="The last administrator cannot be deleted")
    db.execute(delete(AuthSession).where(AuthSession.user_id == user_id))
    db.delete(user)
    db.commit()