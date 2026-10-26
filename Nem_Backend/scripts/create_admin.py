"""Create the first local administrator interactively."""
import getpass
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings
from app.db.init_db import initialize_database
from app.db.session import create_database_engine, create_session_factory
from app.models import User
from app.services.auth_security import hash_password


def main() -> int:
    username = input("Administrator username: ").strip().casefold()
    if not username:
        print("Username cannot be empty.", file=sys.stderr)
        return 2
    password = getpass.getpass("Administrator password (minimum 12 characters): ")
    if password != getpass.getpass("Confirm password: "):
        print("Passwords do not match.", file=sys.stderr)
        return 2
    try:
        password_hash = hash_password(password)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    engine = create_database_engine(get_settings().database_url)
    try:
        initialize_database(engine)
        with create_session_factory(engine)() as db:
            if db.scalar(select(User.id).where(User.username == username)) is not None:
                print("That username already exists; no changes made.", file=sys.stderr)
                return 1
            db.add(User(
                username=username,
                password_hash=password_hash,
                role="Administrator",
                is_active=True,
            ))
            db.commit()
        print(f"Administrator '{username}' created.")
        return 0
    finally:
        engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
