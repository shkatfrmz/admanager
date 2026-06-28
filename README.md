# AD Manager

A full Active Directory manager for **hybrid environments** (On-Prem AD + Azure AD / O365).

## Stack
- **Node.js + Express** — REST API backend
- **ldapjs** — Write operations to On-Prem AD (create, modify, delete, password reset)
- **activedirectory2** — Read/query operations against On-Prem AD
- **SQLite (better-sqlite3)** — Local cache of AD users/groups for fast reads
- **node-cron** — Background job that re-syncs the cache from AD every 2 minutes
- **Microsoft Graph API** — Azure AD / O365 (licenses, mailbox, MFA)
- **JWT** — Session authentication

---

## How the caching layer works

Querying AD live on every page load is slow and puts unnecessary load on your DC. Instead:

```
Every 2 minutes (cron):
  AD (LDAP) ──sync──▶ SQLite (db/ad-cache.sqlite)

Every page load:
  Frontend ──fetch──▶ SQLite (instant, no LDAP round-trip)

Write actions (create/disable/delete/etc):
  Frontend ──▶ AD (LDAP write) ──▶ SQLite patched immediately
```

- **Reads** (`GET /api/users`, `GET /api/groups`, `/members`) always come from SQLite — fast, no AD round-trip.
- **Writes** (create, enable/disable, delete, group membership) go straight to AD via `ldapjs`, then the same row is patched in SQLite so the UI reflects the change instantly, without waiting for the next 2-minute cycle.
- A full re-sync from AD still runs every 2 minutes in the background to catch anything changed outside the app (e.g. directly in ADUC, or by Azure AD Connect writeback).
- Force an immediate sync any time: `POST /api/sync/run`
- Check sync health: `GET /api/sync/status`

The cache lives in a single file: `db/ad-cache.sqlite`. Delete it any time to force a clean rebuild on next boot — no migrations needed.

## Prerequisites

1. **Node.js v20+** installed on your Windows Server 2019
2. Server must be **domain joined**
3. A **service account** in AD with appropriate permissions
4. **Port 389** (LDAP) or **636** (LDAPS) open to the DC
5. An **Azure App Registration** for Graph API access

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
# Copy the example env file
copy .env.example .env

# Edit .env with your actual values
notepad .env
```

Fill in your `.env`:
```
AD_URL=ldap://YOUR-DC-IP
AD_BASE_DN=dc=yourdomain,dc=com
AD_USERNAME=svc-admanager@yourdomain.com
AD_PASSWORD=YourPassword
AD_USERS_OU=OU=Users,DC=yourdomain,DC=com

AZURE_TENANT_ID=from-azure-app-registration
AZURE_CLIENT_ID=from-azure-app-registration
AZURE_CLIENT_SECRET=from-azure-app-registration

JWT_SECRET=some-long-random-string
```

### 3. Create AD Service Account
In Active Directory Users and Computers:
- Create a user: `svc-admanager`
- Add to **Account Operators** group (for user management)
- Or assign granular delegated permissions on specific OUs

### 4. Azure App Registration (for Graph API)
1. Go to **Azure Portal → App Registrations → New Registration**
2. Name it `AD Manager`
3. Go to **API Permissions → Add Permission → Microsoft Graph → Application**
4. Add these permissions:
   - `User.ReadWrite.All`
   - `Group.ReadWrite.All`
   - `Directory.ReadWrite.All`
   - `Organization.Read.All`
5. Click **Grant admin consent**
6. Go to **Certificates & Secrets → New client secret** — copy the value into `.env`

### 5. Start the app
```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```

App runs at: `http://localhost:3000`

---

## API Reference

### Authentication
```
POST /api/auth/login
Body: { "username": "user@domain.com", "password": "..." }
Returns: { token, user }
```

All other endpoints require: `Authorization: Bearer <token>`

### Users (On-Prem AD)
```
GET    /api/users                        # List all users
GET    /api/users?search=john            # Search users
GET    /api/users/:username              # Get single user
GET    /api/users/:username/groups       # Get user's groups
POST   /api/users                        # Create user
PATCH  /api/users/:dn                    # Update user attributes
POST   /api/users/:dn/enable             # Enable account
POST   /api/users/:dn/disable            # Disable account
POST   /api/users/:dn/reset-password     # Reset password
POST   /api/users/:dn/move               # Move to different OU
DELETE /api/users/:dn                    # Delete user
```

### Groups (On-Prem AD)
```
GET    /api/groups                            # List all groups
GET    /api/groups/:groupName/members         # List group members
POST   /api/groups/:groupDN/members           # Add user to group
DELETE /api/groups/:groupDN/members/:userDN   # Remove user from group
```

### Licenses / O365 (Azure via Graph API)
```
GET    /api/licenses                          # Available licenses in tenant
GET    /api/licenses/users/:upn               # User's current licenses
POST   /api/licenses/users/:upn/assign        # Assign license
DELETE /api/licenses/users/:upn/:skuId        # Remove license
```

### Sync (AD → SQLite cache)
```
GET    /api/sync/status                       # Last sync time + history
POST   /api/sync/run                          # Force a full sync right now
```

---

## Create User Example

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Doe",
    "username": "jdoe",
    "upn": "jdoe@yourdomain.com",
    "password": "Welcome@123",
    "department": "IT",
    "title": "Engineer",
    "email": "jdoe@yourdomain.com"
  }'
```

---

## Important Notes

- **Always write to On-Prem AD** for user lifecycle (create/disable/delete). AD Connect will sync to Azure/O365 automatically (every 30 mins).
- **Use Graph API only** for cloud-only operations: license assignment, MFA, mailbox settings.
- Password resets via LDAP require **LDAPS (port 636)** — plain LDAP (389) will reject unicodePwd changes.
- The service account needs **"Reset Password"** delegated permission on the target OUs.

---

## Project Structure
```
ad-manager/
├── config/
│   ├── ad.config.js        # LDAP / AD connection settings
│   └── graph.config.js     # Azure / Graph API credentials
├── routes/
│   ├── auth.js             # Login endpoint
│   ├── users.js            # User CRUD endpoints
│   ├── groups.js           # Group management endpoints
│   └── licenses.js         # M365 license endpoints
├── services/
│   ├── ad.service.js       # All LDAP operations
│   └── graph.service.js    # All Graph API operations
├── middleware/
│   └── auth.js             # JWT authentication middleware
├── public/                 # Frontend (add your React/HTML here)
├── .env.example            # Environment variable template
├── .env                    # Your actual config (never commit!)
├── server.js               # App entry point
└── package.json
```
