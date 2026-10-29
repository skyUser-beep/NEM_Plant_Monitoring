"""Standard-library password hashing and opaque session token helpers."""
import hashlib
import hmac
import secrets

PASSWORD_HASH_ITERATIONS = 600_000

def hash_password(password: str) -> str:
    if len(password) < 6:
        raise ValueError("Password must contain at least 6 characters")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_HASH_ITERATIONS)
    return f"pbkdf2_sha256${PASSWORD_HASH_ITERATIONS}${salt.hex()}${digest.hex()}"

def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, rounds, salt_hex, digest_hex = stored.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        iteration_count = int(rounds)
        if not 100_000 <= iteration_count <= 2_000_000:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            iteration_count,
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False

def new_session_token() -> str:
    return secrets.token_urlsafe(48)

def hash_session_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()