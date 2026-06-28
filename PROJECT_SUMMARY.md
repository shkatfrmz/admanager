# AD Manager — Project Summary

> High-level overview for anyone joining this project. Created: 2026-06-28.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js (v18+ recommended) |
| Backend framework | Express.js |
| Database | SQLite via `better-sqlite3` (WAL mode enabled) |
| AD integration | `ldapjs` (read/write), `activedirectory2` (legacy lookups) |
| Auth | JWT (`jsonwebtoken`), AD username/password validation |
| File uploads | `multer` (packages uploaded to `uploads/packages/`) |
| Scheduling | `node-cron` |
| Frontend | Single HTML file: `public/index.html` (vanilla JS, no framework) |
| Agent | PowerShell 5.1+ script running as SYSTEM/Admin on endpoints |
| Password hashing | AD `unicodePwd` with `\"${pwd}\"` UTF-16LE encoding |

## Architecture

- **One Express server** listens on `PORT` (default 3000) in `server.js`.
- **All UI** is served from `public/index.html` (SPA with client-side routing).
- **REST API** under `/api/*`.
- **JWT middleware** protects admin routes; agent-facing routes (`/api/endpoints/register`, `/heartbeat`, `/deployments/*`) are open.
- **SQLite cache** mirrors AD users, groups, computers, endpoints, deployments, audit log, scheduled access.
- **Sync service** (`services/sync.service.js`) runs every minute: `syncUsers()` → `syncGroups()` → `syncComputers()`.
- **Agent polling**: endpoints call `GET /api/endpoints/deployments/pending/:id` every heartbeat interval.

## Key Directories

```
├── public/index.html          # Entire frontend
├── server.js                  # Express bootstrapping
├── routes/                    # Express route modules
│   ├── auth.js                # Login / token
│   ├── users.js               # User CRUD, password reset, bulk ops
│   ├── groups.js              # Group CRUD, members
│   ├── computers.js           # Computer CRUD + cached pagination
│   ├── contacts.js            # Contact CRUD
│   ├── endpoints.js           # Endpoint registration, heartbeat, deployments, file upload
│   ├── reports.js             # Dashboard stats, reports, LDAP query, recycle bin, attributes
│   ├── scheduled.js           # Scheduled access
│   └── audit.js               # Audit log
├── services/                  # Business logic
│   ├── ad.service.js          # AD operations (ldapjs/activedirectory2)
│   ├── sync.service.js        # Scheduled AD → SQLite sync
│   ├── audit.service.js       # Audit logging helper
│   └── graph.service.js       # Microsoft Graph placeholders
├── db/                        # Data layer
│   ├── database.js            # SQLite schema
│   └── cache.repository.js    # Cache CRUD helpers
├── middleware/auth.js         # JWT verification
├── agent/                     # Endpoint agent
│   └── ad-manager-agent.ps1   # PowerShell agent
└── uploads/packages/          # Uploaded deployment packages
```

## Main Features

1. **Dashboard** — real AD counts (users/groups/computers/contacts), clickable stat cards, charts.
2. **Users** — paginated table, search, bulk enable/disable/delete/reset-password, create/edit user, user profile modal, GMSA creation.
3. **Groups** — paginated, search, members, create/edit/delete, type derived from `groupType`.
4. **Computers** — server-side paginated cache, search, enable/disable/reset/delete.
5. **Scheduled Access** — add user to group with auto-expiry; agent checks every 30s but server-side cron removes them.
6. **Software Deployment** — upload package, deploy to endpoints, agent downloads & installs silently.
7. **Reports** — category-organized tiles, LDAP filter builder.
8. **Tools tile** — Self-Service Password Reset, AD Recycle Bin, Attribute Editor, RBAC info, Photo Upload.
9. **Dark mode** — persisted in `localStorage`.
10. **Audit log** — action history.

## Important Patterns / Gotchas

- **ldapjs v3** returns Buffer values for some attributes (`userAccountControl`, `lastLogon`). Convert to string/number before SQLite upsert.
- **Paged AD queries** use `res.cookie` in ldapjs v3, not `res.controls`.
- **AD MaxPageSize (1000)** is bypassed via `paged: { pageSize: 1000, cookie }`.
- **Deleted object DNs** contain a control byte + `DEL:<guid>` marker. Restore uses name wildcard + `Restore-ADObject`.
- **Agent script must use ASCII-only characters**; Unicode em-dashes/box-drawing break PowerShell parser.
- **Agent `ServerUrl`** must be the AD Manager server IP/hostname reachable from the endpoint, not `localhost` unless same machine.
- **Duplicate packages** are auto-cleaned on upload; only the latest file per `original_name` is kept.

## Common Commands

```powershell
# Install dependencies
npm install

# Start server
npm start

# Verify health
Invoke-RestMethod http://localhost:3000/api/health
```

## Environment Variables (`.env`)

```env
PORT=3000
JWT_SECRET=change-me
AD_URL=ldap://DC.labnet.local
AD_BASE_DN=DC=labnet,DC=local
AD_USERNAME=sysadmin@labnet.local
AD_PASSWORD=...
AD_USERS_OU=CN=Users,DC=labnet,DC=local
AD_COMPUTERS_OU=CN=Computers,DC=labnet,DC=local
```

## Current State (last known)

- Users cached: ~13,600
- Groups cached: ~120
- Computers cached: ~4,000
- Server: running on `http://localhost:3000`
- Agents: WINCLIENT10 and DC online, deployment pipeline working
