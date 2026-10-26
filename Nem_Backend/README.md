# Local accounts and access control

The backend supports local username/password accounts with three roles:

- **Administrator** can manage accounts, settings, machine configuration, and all machines.
- **Operator** can monitor and operate assigned machines.
- **Supervisor** can manage monitoring and maintenance on explicitly assigned machines.
- **Operator** can view assigned task information and acknowledge active alerts only.

See [AUTHENTICATION.md](./AUTHENTICATION.md) for role permissions, database
upgrades, and authentication endpoint details.

All `/api/v1/` endpoints require a bearer session except `/api/v1/health`,
`/api/v1/ready`, and `/api/v1/auth/login`. The legacy `/plc/test` compatibility
endpoint is also protected and requires an Administrator account. Sessions expire after
eight hours; logging out, disabling an account, or changing its role/password
revokes its existing sessions. Live-update WebSockets recheck session and
machine access as they send updates.

## Create the first administrator

Configure the existing PostgreSQL connection in `Nem_Backend/.env`, then run
from the `Nem_Backend` directory:

```powershell
.\.venv\Scripts\python.exe scripts\create_admin.py
```

The script initializes the database tables if needed, prompts for a username
and a password of at least 12 characters, and refuses to overwrite an existing
username. Keep this administrator account available; the API prevents removing
or disabling the last active administrator.

## Account administration

Sign in through `POST /api/v1/auth/login` and send the returned token as
`Authorization: Bearer <token>`. An Admin can use the **User access** page to
create accounts, set a user's role and active status, reset a password, and
assign machines. Non-Admin asset queries and writes are restricted to the
assigned machine IDs.

The frontend stores the session token in browser local storage. Use a trusted
HTTPS deployment and protect the browser session accordingly.
