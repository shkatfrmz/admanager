# AD Manager - Restore Guide

This backup was created on: **2026-06-28**

## Contents of this Backup

- Source code (`public/`, `routes/`, `services/`, `db/`, `middleware/`, `agent/`)
- SQLite cache database (`db/ad-cache.sqlite`)
- Configuration files (`.env.example`, `package.json`, etc.)
- Agent scripts and installer helpers

**Not included**: `node_modules/`, `.git/`, uploaded deployment packages (`uploads/packages/`).

---

## Prerequisites

Install the following on the target Windows machine before restoring:

1. **Node.js LTS** (v18 or later recommended)
   - Download from: https://nodejs.org/en/download
   - Verify: `node -v` and `npm -v`

2. **Windows PowerShell 5.1 or PowerShell 7**
   - Required for agent scripts and AD operations.

3. **Active Directory access**
   - The server must be able to reach the domain controller.
   - Service account with rights to read/write AD objects.

4. **Network access**
   - Agents must reach the AD Manager server URL.
   - Default server port: **3000**.

---

## Step-by-Step Restore

### 1. Extract the Backup

Extract the zip file to a folder, for example:

```powershell
C:\ADManager
```

### 2. Install Dependencies

Open PowerShell or Command Prompt in the extracted folder and run:

```powershell
cd C:\ADManager
npm install
```

This recreates the `node_modules/` folder.

### 3. Configure Environment

Copy the example environment file and edit it:

```powershell
copy .env.example .env
notepad .env
```

Minimum required values in `.env`:

```env
PORT=3000
JWT_SECRET=change-this-to-a-random-secret
AD_URL=ldap://DC.labnet.local
AD_BASE_DN=DC=labnet,DC=local
AD_USERNAME=sysadmin@labnet.local
AD_PASSWORD=YourPasswordHere
AD_USERS_OU=CN=Users,DC=labnet,DC=local
AD_COMPUTERS_OU=CN=Computers,DC=labnet,DC=local
```

> **Security note:** Never commit `.env` to source control.

### 4. Start the Server

```powershell
npm start
```

You should see:

```
AD Manager Running
http://localhost:3000
```

### 5. Open the Web App

Browse to:

```
http://localhost:3000
```

Login with the AD credentials configured in `.env`.

---

## Agent Installation on Endpoints

After the server is running, install the agent on each managed endpoint:

1. Copy the agent folder to the target machine:

   ```powershell
   C:\ProgramData\ADManagerAgent\ad-manager-agent.ps1
   ```

2. Edit the agent script so `ServerUrl` points to the AD Manager server:

   ```powershell
   [string]$ServerUrl = "http://192.168.1.111:3000"
   ```

   Use the actual IP/hostname of the AD Manager server as reachable from the endpoint.

3. Start the agent (run as Administrator or SYSTEM):

   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\ProgramData\ADManagerAgent\ad-manager-agent.ps1
   ```

4. To run persistently, create a scheduled task or run the agent in a background loop.

---

## Important Notes

- **Database**: The SQLite file `db/ad-cache.sqlite` is included. It contains cached users, groups, computers, endpoints, deployment history, audit logs, and scheduled access records.
- **Uploaded packages**: The `uploads/packages/` folder is **not** included in this backup. After restore, re-upload any software packages before deploying.
- **Agents**: Endpoint agents will re-register automatically when they connect to the restored server.
- **Port**: If you change `PORT` in `.env`, update agent `ServerUrl` values accordingly.
- **SSL/TLS**: For production, configure HTTPS and update `AD_URL` to `ldaps://`.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `Cannot find module ...` | Run `npm install` again. |
| `Access denied. No token provided.` | Check `JWT_SECRET` is set and restart the server. |
| Agent shows offline | Verify agent `ServerUrl`, firewall, and that the server is reachable. |
| SQLite database locked | Stop the server before copying `ad-cache.sqlite`. |
| Deployments fail with disk space error | Change agent temp directory or free disk space on the endpoint. |

---

## Quick Health Check

After restore, verify these endpoints respond:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/users/stats
```

Both should return JSON data without errors.
