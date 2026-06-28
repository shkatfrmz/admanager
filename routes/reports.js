const express = require('express');
const router = express.Router();
const cache = require('../db/cache.repository');
const db = require('../db/database');
const adService = require('../services/ad.service');
const audit = require('../services/audit.service');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

function isDisabled(uac) { return (uac & 2) !== 0; }
function isLocked(uac) { return (uac & 16) !== 0; }
function pwdNeverExpires(uac) { return (uac & 65536) !== 0; }
function pwdCantChange(uac) { return (uac & 64) !== 0; }
function passwordNotRequired(uac) { return (uac & 32) !== 0; }
function smartcardRequired(uac) { return (uac & 262144) !== 0; }
function isDisabledComputer(uac) { return (uac & 2) !== 0; }

const categories = [
  {
    id: 'user', name: 'User Reports', icon: '👤',
    reports: [
      { id: 'all-users', name: 'All Users', desc: 'Every user account in the domain' },
      { id: 'active-users', name: 'Active Users', desc: 'Users with enabled accounts' },
      { id: 'disabled-users', name: 'Disabled Users', desc: 'Users whose accounts are disabled' },
      { id: 'locked-users', name: 'Locked Out Users', desc: 'Users currently locked out' },
      { id: 'inactive-users', name: 'Inactive Users (90d+)', desc: 'Users who have not logged on in 90+ days' },
      { id: 'recent-users', name: 'Recently Created Users', desc: 'Users created in the last 30 days' },
      { id: 'smartcard-users', name: 'Smartcard Required', desc: 'Users requiring smartcard logon' },
    ]
  },
  {
    id: 'password', name: 'Password Reports', icon: '🔑',
    reports: [
      { id: 'pwd-expired', name: 'Password Expired', desc: 'Users whose password has expired (>42 days)' },
      { id: 'pwd-never-expires', name: 'Password Never Expires', desc: 'Users with password never expires flag' },
      { id: 'pwd-cant-change', name: 'User Cannot Change Password', desc: 'Users prevented from changing password' },
      { id: 'pwd-not-required', name: 'Password Not Required', desc: 'Users with no password requirement' },
    ]
  },
  {
    id: 'group', name: 'Group Reports', icon: '👥',
    reports: [
      { id: 'all-groups', name: 'All Groups', desc: 'Every group in the domain' },
      { id: 'security-groups', name: 'Security Groups', desc: 'Groups used for access control' },
      { id: 'distribution-groups', name: 'Distribution Groups', desc: 'Groups used for email distribution' },
      { id: 'empty-groups', name: 'Empty Groups', desc: 'Groups with zero members' },
      { id: 'top-groups', name: 'Top 15 Largest Groups', desc: 'Groups with the most members' },
    ]
  },
  {
    id: 'computer', name: 'Computer Reports', icon: '💻',
    reports: [
      { id: 'all-computers', name: 'All Computers', desc: 'Every computer in the domain' },
      { id: 'active-computers', name: 'Active Computers', desc: 'Enabled computer accounts' },
      { id: 'disabled-computers', name: 'Disabled Computers', desc: 'Disabled computer accounts' },
    ]
  },
  {
    id: 'contact', name: 'Contact Reports', icon: '📇',
    reports: [
      { id: 'all-contacts', name: 'All Contacts', desc: 'Every contact object in the domain' },
    ]
  },
  {
    id: 'ou', name: 'OU Reports', icon: '📁',
    reports: [
      { id: 'all-ous', name: 'All Organizational Units', desc: 'Every OU in the domain tree' },
    ]
  },
  {
    id: 'audit', name: 'Audit Reports', icon: '📋',
    reports: [
      { id: 'audit-summary', name: 'Audit Log Summary', desc: 'Activity breakdown and recent events' },
      { id: 'today-activity', name: 'Today\'s Activity', desc: 'All audit events from the last 24 hours' },
    ]
  },
  {
    id: 'summary', name: 'AD Summary Reports', icon: '📊',
    reports: [
      { id: 'domain-summary', name: 'Domain Summary', desc: 'Overall counts: users, groups, computers, contacts' },
    ]
  }
];

router.get('/', (req, res) => {
  const flat = [];
  for (const cat of categories) {
    for (const r of cat.reports) {
      flat.push({ id: r.id, name: r.name, category: cat.name, icon: cat.icon, desc: r.desc });
    }
  }
  res.json({ success: true, count: flat.length, categories, reports: flat });
});

// ── GET deleted objects (AD Recycle Bin) ─────────────────────────────────────
router.get('/deleted-objects', async (req, res) => {
  try {
    const objects = await adService.getDeletedObjects();
    res.json({ success: true, objects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST restore deleted object ──────────────────────────────────────────────
router.post('/restore', async (req, res) => {
  try {
    const { dn, parentDN } = req.body;
    if (!dn) return res.status(400).json({ error: 'DN is required' });
    const result = await adService.restoreDeletedObject(dn, parentDN);
    res.json(result);
  } catch (err) {
    const msg = (err.message || '').replace(/<[^>]+>/g, '').replace(/&#x[0-9A-F]+;/gi, '').replace(/\s+/g, ' ').trim();
    res.status(500).json({ error: msg || 'Restore failed' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let data = [];

    switch (id) {
      case 'all-users': {
        data = cache.getAllUsers(20000, 0);
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          Title: u.title || '—',
          Status: u.userAccountControl && isDisabled(u.userAccountControl) ? 'Disabled' : 'Active',
          DN: u.dn
        }));
        break;
      }
      case 'active-users': {
        data = (cache.getAllUsers(20000, 0) || []).filter(u => !u.userAccountControl || !isDisabled(u.userAccountControl));
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          Title: u.title || '—',
          Last_Logon: u.lastLogon ? new Date(parseInt(u.lastLogon) * 10000 - 11644473600000).toLocaleDateString() : 'Never',
          DN: u.dn
        }));
        break;
      }
      case 'disabled-users': {
        data = (cache.getAllUsers(20000, 0) || []).filter(u => u.userAccountControl && isDisabled(u.userAccountControl));
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          Disabled_Since: '—',
          DN: u.dn
        }));
        break;
      }
      case 'locked-users': {
        data = (cache.getAllUsers(20000, 0) || []).filter(u => u.userAccountControl && isLocked(u.userAccountControl));
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          DN: u.dn
        }));
        break;
      }
      case 'inactive-users': {
        const all = cache.getAllUsers(20000, 0) || [];
        const cutoff = Date.now() - 90 * 86400000;
        data = all.filter(u => !u.lastLogon || new Date(parseInt(u.lastLogon) * 10000 - 11644473600000).getTime() < cutoff);
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          Last_Logon: u.lastLogon ? new Date(parseInt(u.lastLogon) * 10000 - 11644473600000).toLocaleDateString() : 'Never',
          DN: u.dn
        }));
        break;
      }
      case 'recent-users': {
        const allUsers = cache.getAllUsers(20000, 0) || [];
        const cutoff = Date.now() - 30 * 86400000;
        data = allUsers.filter(u => u.whenCreated && new Date(u.whenCreated).getTime() > cutoff);
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          Created: u.whenCreated ? new Date(u.whenCreated).toLocaleDateString() : '—',
          DN: u.dn
        }));
        break;
      }
      case 'smartcard-users': {
        data = (cache.getAllUsers(20000, 0) || []).filter(u => u.userAccountControl && smartcardRequired(u.userAccountControl));
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          DN: u.dn
        }));
        break;
      }
      case 'pwd-expired': {
        const allPwd = cache.getAllUsers(20000, 0) || [];
        const now = new Date();
        data = allPwd.filter(u => {
          if (!u.pwdLastSet) return false;
          const pwdAge = (now - new Date(parseInt(u.pwdLastSet) * 10000 - 11644473600000)) / 86400000;
          return pwdAge > 42;
        });
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Dept: u.department || '—',
          Last_Pwd_Set: u.pwdLastSet ? new Date(parseInt(u.pwdLastSet) * 10000 - 11644473600000).toLocaleDateString() : '—',
          DN: u.dn
        }));
        break;
      }
      case 'pwd-never-expires': {
        data = (cache.getAllUsers(20000, 0) || []).filter(u => u.userAccountControl && pwdNeverExpires(u.userAccountControl));
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          DN: u.dn
        }));
        break;
      }
      case 'pwd-cant-change': {
        data = (cache.getAllUsers(20000, 0) || []).filter(u => u.userAccountControl && pwdCantChange(u.userAccountControl));
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          DN: u.dn
        }));
        break;
      }
      case 'pwd-not-required': {
        data = (cache.getAllUsers(20000, 0) || []).filter(u => u.userAccountControl && passwordNotRequired(u.userAccountControl));
        data = data.map(u => ({
          Username: u.sAMAccountName,
          Name: u.displayName || u.sAMAccountName,
          Email: u.mail || '—',
          Department: u.department || '—',
          DN: u.dn
        }));
        break;
      }
      case 'all-groups': {
        data = cache.getAllGroups(5000, 0);
        data = data.map(g => ({
          Name: g.cn,
          Description: g.description || '—',
          DN: g.dn
        }));
        break;
      }
      case 'security-groups': {
        data = (cache.getAllGroups(5000, 0) || []).filter(g => g.groupType === '2147483650' || g.groupType === '2');
        data = data.map(g => ({
          Name: g.cn,
          Description: g.description || '—',
          DN: g.dn
        }));
        break;
      }
      case 'distribution-groups': {
        data = (cache.getAllGroups(5000, 0) || []).filter(g => g.groupType === '2147483652' || g.groupType === '4' || g.groupType === '8');
        data = data.map(g => ({
          Name: g.cn,
          Description: g.description || '—',
          DN: g.dn
        }));
        break;
      }
      case 'empty-groups': {
        data = (cache.getAllGroups(5000, 0) || []).filter(g => !g.member || g.member === '' || (Array.isArray(g.member) && g.member.length === 0));
        data = data.map(g => ({
          Name: g.cn,
          Description: g.description || '—',
          DN: g.dn
        }));
        break;
      }
      case 'top-groups': {
        const groups = cache.getAllGroups(5000, 0) || [];
        data = groups
          .map(g => ({ Name: g.cn, Members: Array.isArray(g.member) ? g.member.length : (g.member ? 1 : 0), DN: g.dn }))
          .sort((a, b) => b.Members - a.Members)
          .slice(0, 15);
        break;
      }
      case 'all-computers': {
        const comps = await adService.searchComputers();
        data = comps.map(c => ({
          Name: c.cn || c.sAMAccountName,
          OS: c.operatingSystem || '—',
          OS_Version: c.operatingSystemVersion || '—',
          DNS_Name: c.dNSHostName || '—',
          Status: c.userAccountControl && isDisabledComputer(c.userAccountControl) ? 'Disabled' : 'Active',
          DN: c.dn || c.distinguishedName
        }));
        break;
      }
      case 'active-computers': {
        const allComps = await adService.searchComputers();
        data = allComps.filter(c => !c.userAccountControl || !isDisabledComputer(c.userAccountControl));
        data = data.map(c => ({
          Name: c.cn || c.sAMAccountName,
          OS: c.operatingSystem || '—',
          DNS_Name: c.dNSHostName || '—',
          DN: c.dn || c.distinguishedName
        }));
        break;
      }
      case 'disabled-computers': {
        const dcComps = await adService.searchComputers();
        data = dcComps.filter(c => c.userAccountControl && isDisabledComputer(c.userAccountControl));
        data = data.map(c => ({
          Name: c.cn || c.sAMAccountName,
          OS: c.operatingSystem || '—',
          DNS_Name: c.dNSHostName || '—',
          DN: c.dn || c.distinguishedName
        }));
        break;
      }
      case 'all-contacts': {
        const contacts = await adService.searchContacts();
        data = contacts.map(c => ({
          Name: c.displayName || c.cn,
          Email: c.mail || '—',
          Phone: c.telephoneNumber || '—',
          Department: c.department || '—',
          Company: c.company || '—',
          DN: c.dn || c.distinguishedName
        }));
        break;
      }
      case 'all-ous': {
        const ous = await adService.searchOUs();
        data = ous.map(o => ({
          Name: o.name || o.cn,
          DN: o.distinguishedName
        }));
        break;
      }
      case 'audit-summary': {
        const stats = db.prepare('SELECT action, COUNT(*) as c FROM audit_log GROUP BY action ORDER BY c DESC').all();
        const recent = db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 50').all();
        data = { stats, recent };
        break;
      }
      case 'today-activity': {
        const cutoff = new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');
        const entries = db.prepare('SELECT * FROM audit_log WHERE timestamp >= ? ORDER BY timestamp DESC').all(cutoff);
        data = entries.map(e => ({
          Timestamp: e.timestamp,
          User: e.username || '—',
          Action: e.action,
          Target: e.target || '—',
          Status: e.status
        }));
        break;
      }
      case 'domain-summary': {
        const userCount = cache.getTotalUsersCount();
        const groupCount = cache.getTotalGroupsCount();
        const stats = cache.getStats();
        let compCount = 0, contactCount = 0, ouCount = 0;
        try {
          const comps = await adService.searchComputers();
          compCount = comps.length;
        } catch (_) { }
        try {
          const contacts = await adService.searchContacts();
          contactCount = contacts.length;
        } catch (_) { }
        try {
          const ous = await adService.searchOUs();
          ouCount = ous.length;
        } catch (_) { }
        data = {
          Total_Users: userCount,
          Active_Users: stats.activeUsers,
          Disabled_Users: stats.disabledUsers,
          Total_Groups: groupCount,
          Total_Computers: compCount,
          Total_Contacts: contactCount,
          Total_OUs: ouCount
        };
        break;
      }
      default:
        return res.status(404).json({ error: 'Unknown report type' });
    }

    res.json({ success: true, report: id, data, count: Array.isArray(data) ? data.length : undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST advanced LDAP query ────────────────────────────────────────────────
router.post('/ldap-query', async (req, res) => {
  try {
    const { objectClass, filter, attributes } = req.body;
    const results = await adService.ldapQuery(objectClass, filter, attributes);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST read attribute ──────────────────────────────────────────────────────
router.post('/read-attribute', async (req, res) => {
  try {
    const { dn, attribute } = req.body;
    const value = await adService.readAttribute(dn, attribute);
    res.json({ success: true, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST write attribute ──────────────────────────────────────────────────────
router.post('/write-attribute', async (req, res) => {
  try {
    const { dn, attribute, value } = req.body;
    const result = await adService.writeAttribute(dn, attribute, value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
