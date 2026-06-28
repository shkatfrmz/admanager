const ldap = require('ldapjs');
const ActiveDirectory = require('activedirectory2');
const adConfig = require('../config/ad.config');

console.log('[ad.service] Config loaded:', {
  url: adConfig.url,
  baseDN: adConfig.baseDN,
  username: adConfig.username,
  usersOU: adConfig.usersOU
});

// ── activedirectory2 client (for easy reads/auth) ──────────────────────────
const ad = new ActiveDirectory({
  url: adConfig.url,
  baseDN: adConfig.baseDN,
  username: adConfig.username,
  password: adConfig.password
});

// ── ldapjs client factory (for writes) ─────────────────────────────────────
function createClient() {
  // Use LDAPS URL from ldapOptions for write operations (required for password changes)
  const client = ldap.createClient(adConfig.ldapOptions);
  
  // Add error event handler to prevent unhandled errors from crashing the server
  client.on('error', (err) => {
    console.warn('[ad.service] LDAP client error (ignored):', err.code);
  });
  
  // Prevent connection close from causing issues
  client.on('close', () => {
    console.log('[ad.service] LDAP connection closed');
  });
  
  return new Promise((resolve, reject) => {
    client.bind(adConfig.username, adConfig.password, (err) => {
      if (err) return reject(err);
      resolve(client);
    });
  });
}

// ── Encode password for AD (unicodePwd requires UTF-16LE with quotes) ───────
function encodePassword(password) {
  return Buffer.from(`"${password}"`, 'utf16le');
}

function dateToADFiletime(date) {
  // AD filetime is 100-nanosecond intervals since Jan 1 1601
  const epoch = new Date('1601-01-01T00:00:00Z');
  const diff = date.getTime() - epoch.getTime();
  return String(diff * 10000);
}

// ════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Authenticate a user against AD
 * @param {string} username - UPN (user@domain.com)
 * @param {string} password
 */
function authenticateUser(username, password) {
  return new Promise((resolve, reject) => {
    ad.authenticate(username, password, (err, auth) => {
      if (err) return reject(err);
      resolve(auth);
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// READ OPERATIONS (activedirectory2)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Find a single user by UPN or sAMAccountName
 */
function findUser(username) {
  return new Promise((resolve, reject) => {
    ad.findUser(username, (err, user) => {
      if (err) return reject(err);
      resolve(user);
    });
  });
}

function findUserFull(username) {
  return new Promise((resolve, reject) => {
    const opts = {
      filter: `(|(sAMAccountName=${username})(userPrincipalName=${username}))`,
      attributes: ['*']
    };
    ad.findUsers(opts, (err, users) => {
      if (err) return reject(err);
      if (!users || !users.length) return resolve(null);
      const u = users[0];
      const result = { dn: u.dn, manager: null, directReports: [] };
      if (u.manager) result.manager = Array.isArray(u.manager) ? u.manager[0] : u.manager;
      if (u.directReports) result.directReports = Array.isArray(u.directReports) ? u.directReports : [u.directReports];
      resolve(result);
    });
  });
}

/**
 * Find all users in the directory (uses activedirectory2 with paging)
 */
function getAllUsers() {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url: adConfig.url });
    client.bind(adConfig.username, adConfig.password, (err) => {
      if (err) { client.unbind(); return reject(err); }
      const attrs = ['sAMAccountName', 'userPrincipalName', 'displayName', 'givenName', 'sn', 'cn', 'mail', 'department', 'title', 'telephoneNumber', 'userAccountControl', 'whenCreated', 'lastLogon', 'distinguishedName'];
      const all = [];
      let cookie = Buffer.alloc(0);
      function doSearch() {
        client.search(adConfig.baseDN, {
          filter: '(&(objectClass=user)(objectCategory=person))',
          scope: 'sub',
          attributes: attrs,
          paged: { pageSize: 1000, cookie: cookie }
        }, (err, res) => {
          if (err) { client.unbind(); return reject(err); }
          res.on('searchEntry', e => {
            const obj = { dn: String(e.objectName || '') };
            if (e.attributes) e.attributes.forEach(a => {
              let val = a.values && a.values.length === 1 ? a.values[0] : (a.values || []);
              if (Buffer.isBuffer(val)) val = val.toString('utf8');
              if (Array.isArray(val)) val = val.map(v => Buffer.isBuffer(v) ? v.toString('utf8') : v);
              if (a.type === 'userAccountControl' || a.type === 'lastLogon') {
                if (typeof val === 'string') val = parseInt(val, 10) || 0;
                if (Array.isArray(val)) val = val.map(v => typeof v === 'string' ? (parseInt(v, 10) || 0) : v);
              }
              obj[a.type] = val;
            });
            if (!obj.dn) obj.dn = String(obj.distinguishedName || '');
            all.push(obj);
          });
          res.on('end', () => {
            if (res.cookie && res.cookie.length > 0) {
              cookie = res.cookie;
              doSearch();
            } else {
              client.unbind();
              resolve(all);
            }
          });
          res.on('error', e => { client.unbind(); reject(e); });
        });
      }
      doSearch();
    });
  });
}

function getTotalUserCount() {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url: adConfig.url });
    client.bind(adConfig.username, adConfig.password, (err) => {
      if (err) { client.unbind(); return reject(err); }
      let count = 0;
      let cookie = Buffer.alloc(0);
      function doSearch() {
        client.search(adConfig.baseDN, {
          filter: '(&(objectClass=user)(objectCategory=person))',
          scope: 'sub',
          attributes: ['distinguishedName'],
          paged: { pageSize: 1000, cookie: cookie }
        }, (err, res) => {
          if (err) { client.unbind(); return reject(err); }
          res.on('searchEntry', () => count++);
          res.on('end', () => {
            if (res.cookie && res.cookie.length > 0) {
              cookie = res.cookie;
              doSearch();
            } else {
              client.unbind();
              resolve(count);
            }
          });
          res.on('error', e => { client.unbind(); reject(e); });
        });
      }
      doSearch();
    });
  });
}

function getAllComputers() {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url: adConfig.url });
    client.bind(adConfig.username, adConfig.password, (err) => {
      if (err) { client.unbind(); return reject(err); }
      const attrs = ['cn', 'sAMAccountName', 'dNSHostName', 'operatingSystem', 'operatingSystemVersion', 'userAccountControl', 'description', 'whenCreated', 'lastLogon', 'distinguishedName'];
      const all = [];
      let cookie = Buffer.alloc(0);
      function doSearch() {
        client.search(adConfig.baseDN, {
          filter: '(objectClass=computer)',
          scope: 'sub',
          attributes: attrs,
          paged: { pageSize: 1000, cookie: cookie }
        }, (err, res) => {
          if (err) { client.unbind(); return reject(err); }
          res.on('searchEntry', e => {
            const obj = { dn: String(e.objectName || '') };
            if (e.attributes) e.attributes.forEach(a => {
              let val = a.values && a.values.length === 1 ? a.values[0] : (a.values || []);
              if (Buffer.isBuffer(val)) val = val.toString('utf8');
              if (Array.isArray(val)) val = val.map(v => Buffer.isBuffer(v) ? v.toString('utf8') : v);
              if (a.type === 'userAccountControl' || a.type === 'lastLogon') {
                if (typeof val === 'string') val = parseInt(val, 10) || 0;
                if (Array.isArray(val)) val = val.map(v => typeof v === 'string' ? (parseInt(v, 10) || 0) : v);
              }
              obj[a.type] = val;
            });
            if (!obj.dn) obj.dn = String(obj.distinguishedName || '');
            all.push(obj);
          });
          res.on('end', () => {
            if (res.cookie && res.cookie.length > 0) {
              cookie = res.cookie;
              doSearch();
            } else {
              client.unbind();
              resolve(all);
            }
          });
          res.on('error', e => { client.unbind(); reject(e); });
        });
      }
      doSearch();
    });
  });
}

function getTotalComputerCount() {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url: adConfig.url });
    client.bind(adConfig.username, adConfig.password, (err) => {
      if (err) { client.unbind(); return reject(err); }
      let count = 0;
      let cookie = Buffer.alloc(0);
      function doSearch() {
        client.search(adConfig.baseDN, {
          filter: '(objectClass=computer)',
          scope: 'sub',
          attributes: ['distinguishedName'],
          paged: { pageSize: 1000, cookie: cookie }
        }, (err, res) => {
          if (err) { client.unbind(); return reject(err); }
          res.on('searchEntry', () => count++);
          res.on('end', () => {
            if (res.cookie && res.cookie.length > 0) {
              cookie = res.cookie;
              doSearch();
            } else {
              client.unbind();
              resolve(count);
            }
          });
          res.on('error', e => { client.unbind(); reject(e); });
        });
      }
      doSearch();
    });
  });
}

/**
 * Search users with a custom filter
 */
function searchUsers(query) {
  return new Promise((resolve, reject) => {
    const opts = {
      filter: `(&(objectClass=user)(objectCategory=person)(|(displayName=*${query}*)(mail=*${query}*)(sAMAccountName=*${query}*)))`,
      attributes: ['sAMAccountName', 'userPrincipalName', 'displayName', 'cn', 'mail', 'department', 'userAccountControl']
    };
    ad.findUsers(opts, (err, users) => {
      if (err) return reject(err);
      const normalized = (users || []).map(u => {
        const obj = {};
        for (const key of Object.keys(u)) {
          const val = u[key];
          if (Array.isArray(val)) obj[key] = val[0];
          else if (val && typeof val === 'object' && val.low !== undefined) obj[key] = Number(val);
          else obj[key] = val;
        }
        return obj;
      });
      resolve(normalized);
    });
  });
}

/**
 * Get all groups
 */
function getAllGroups() {
  return new Promise((resolve, reject) => {
    // Use specific filter for groups to avoid attribute errors
    const opts = {
      filter: '(objectClass=group)',
      attributes: ['cn', 'name', 'description', 'distinguishedName', 'dn', 'groupType']
    };
    ad.findGroups(opts, (err, groups) => {
      if (err) return reject(err);
      resolve(groups || []);
    });
  });
}

/**
 * Get members of a group
 */
function getGroupMembers(groupName) {
  return new Promise((resolve, reject) => {
    ad.getUsersForGroup(groupName, (err, users) => {
      if (err) return reject(err);
      resolve(users || []);
    });
  });
}

/**
 * Get groups a user belongs to
 */
function getUserGroups(username) {
  return new Promise((resolve, reject) => {
    ad.getGroupMembershipForUser(username, (err, groups) => {
      if (err) return reject(err);
      resolve(groups || []);
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// WRITE OPERATIONS (ldapjs)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a new AD user
 * @param {object} userData
 */

// ── Helper: one-shot operation (create client, run, unbind) ─────────────────
async function oneShot(fn) {
  let client;
  try {
    client = await createClient();
    return await fn(client);
  } finally {
    if (client) try { client.unbind(); } catch (_) {}
  }
}

/**
 * Create a new AD user
 */
async function createUser(userData) {
  const { firstName, lastName, username, upn, password, ou, department, title, email, accountExpiry, passwordNeverExpires, userMustChangePassword, userCannotChangePassword } = userData;
  const dn = `CN=${firstName} ${lastName},${ou || adConfig.usersOU}`;
  console.log('[ad.service] Creating user with:', { dn, username, ou: ou || adConfig.usersOU });

  // Calculate userAccountControl
  let uac = 512; // enabled
  if (passwordNeverExpires) uac += 65536;
  if (userCannotChangePassword) uac += 64;

  // Step 1: Create disabled user
  console.log('[ad.service] Step 1: Creating disabled user...');
  await oneShot(async (client) => {
    const entry = {
      cn: `${firstName} ${lastName}`,
      sn: lastName,
      givenName: firstName,
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: username,
      userPrincipalName: upn || `${username}@labnet.local`,
      displayName: `${firstName} ${lastName}`,
      userAccountControl: '514',
      ...(department && { department }),
      ...(title && { title }),
      ...(email && { mail: email })
    };
    // Set accountExpires if provided
    if (accountExpiry) {
      entry.accountExpires = dateToADFiletime(new Date(accountExpiry));
    }
    await new Promise((resolve, reject) => {
      client.add(dn, entry, (err) => {
        if (err) return reject(err);
        console.log('[ad.service] ok User created (disabled)');
        resolve();
      });
    });
  });

  // Step 2: Set password with a fresh client
  console.log('[ad.service] Step 2: Setting password...');
  await oneShot(async (client) => {
    const pwChange = new ldap.Change({
      operation: 'replace',
      modification: new ldap.Attribute({
        type: 'unicodePwd',
        values: [encodePassword(password)]
      })
    });
    await new Promise((resolve, reject) => {
      client.modify(dn, pwChange, (err) => {
        if (err) {
          console.warn('[ad.service] Password set failed (non-fatal):', err.message);
          return resolve();
        }
        console.log('[ad.service] ok Password set');
        resolve();
      });
    });
  });

  // Step 3: Enable user and set UAC flags
  console.log('[ad.service] Step 3: Enabling user with UAC=' + uac + '...');
  await oneShot(async (client) => {
    const changes = [
      new ldap.Change({
        operation: 'replace',
        modification: new ldap.Attribute({
          type: 'userAccountControl',
          values: [String(uac)]
        })
      })
    ];
    // Set pwdLastSet = 0 to force password change at next logon
    if (userMustChangePassword) {
      changes.push(new ldap.Change({
        operation: 'replace',
        modification: new ldap.Attribute({
          type: 'pwdLastSet',
          values: ['0']
        })
      }));
    }
    await new Promise((resolve, reject) => {
      client.modify(dn, changes, (err) => {
        if (err) return reject(err);
        console.log('[ad.service] ok User enabled with flags');
        resolve();
      });
    });
  });

  console.log('[ad.service] User created successfully:', { dn, username });
  return { success: true, dn, message: `User ${username} created successfully` };
}

/**
 * Create a Group Managed Service Account (GMSA)
 */
async function createGMSA(data) {
  const { name, description, ou, dnsHostName, servicePrincipalNames, managedPasswordInterval, groupMSAMembership } = data;
  const samName = name.endsWith('$') ? name : name + '$';
  const dn = `CN=${name},${ou || adConfig.usersOU}`;
  console.log('[ad.service] Creating GMSA:', { dn, samName, ou: ou || adConfig.usersOU });

  await oneShot(async (client) => {
    const entry = {
      cn: name,
      sAMAccountName: samName,
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'msDS-GroupManagedServiceAccount'],
      'msDS-ManagedPasswordInterval': String(managedPasswordInterval || 30),
      userAccountControl: '512',
      ...(description && { description }),
      ...(dnsHostName && { dNSHostName: dnsHostName }),
      ...(servicePrincipalNames && servicePrincipalNames.length && { servicePrincipalName: servicePrincipalNames })
    };
    if (groupMSAMembership) {
      entry['msDS-GroupMSAMembership'] = groupMSAMembership;
    }
    await new Promise((resolve, reject) => {
      client.add(dn, entry, (err) => {
        if (err) return reject(err);
        console.log('[ad.service] ok GMSA created');
        resolve();
      });
    });
  });

  console.log('[ad.service] GMSA created successfully:', { dn, samName });
  return { success: true, dn, message: `GMSA ${name} created successfully` };
}

/**
 * Disable a user account
 * @param {string} dn - Distinguished Name of user
 */
async function disableUser(dn) {
  let client;
  try {
    client = await createClient();

    const change = new ldap.Change({
      operation: 'replace',
      modification: new ldap.Attribute({
        type: 'userAccountControl',
        values: ['514']  // 512 = enabled, 514 = disabled
      })
    });

    return await new Promise((resolve, reject) => {
      client.modify(dn, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'User disabled successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Enable a user account
 * @param {string} dn - Distinguished Name of user
 */
async function enableUser(dn) {
  let client;
  try {
    client = await createClient();

    const change = new ldap.Change({
      operation: 'replace',
      modification: new ldap.Attribute({
        type: 'userAccountControl',
        values: ['512']
      })
    });

    return await new Promise((resolve, reject) => {
      client.modify(dn, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'User enabled successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Reset a user's password
 * @param {string} dn - Distinguished Name of user
 * @param {string} newPassword
 */
async function resetPassword(identifier, newPassword) {
  let client;
  try {
    // Allow either a DN or a sAMAccountName/UPN
    let dn = identifier;
    if (!identifier.includes('=')) {
      const user = await findUser(identifier);
      if (!user) throw new Error(`User not found: ${identifier}`);
      dn = user.dn;
    }

    client = await createClient();

    const change = new ldap.Change({
      operation: 'replace',
      modification: new ldap.Attribute({
        type: 'unicodePwd',
        values: [encodePassword(newPassword)]
      })
    });

    return await new Promise((resolve, reject) => {
      client.modify(dn, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Password reset successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Update user attributes
 * @param {string} dn
 * @param {object} attributes - key/value pairs to update
 */
async function updateUser(dn, attributes) {
  let client;
  try {
    client = await createClient();

    const changes = Object.entries(attributes).map(([key, value]) => {
      return new ldap.Change({
        operation: 'replace',
        modification: new ldap.Attribute({
          type: key,
          values: [value]
        })
      });
    });

    return await new Promise((resolve, reject) => {
      client.modify(dn, changes, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'User updated successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Delete a user
 * @param {string} dn - Distinguished Name of user
 */
async function deleteUser(dn) {
  let client;
  try {
    client = await createClient();

    return await new Promise((resolve, reject) => {
      client.del(dn, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'User deleted successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Move user to a different OU
 * @param {string} dn - Current DN
 * @param {string} newOU - Target OU DN
 */
async function moveUser(dn, newOU) {
  let client;
  try {
    client = await createClient();

    // Extract the CN part from the DN
    const cn = dn.split(',')[0];

    return await new Promise((resolve, reject) => {
      client.modifyDN(dn, `${cn},${newOU}`, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'User moved successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Check if user is already a member of a group
 * @param {string} userDN
 * @param {string} groupDN
 */
async function isUserInGroup(userDN, groupDN) {
  let client;
  try {
    client = await createClient();
    return await new Promise((resolve, reject) => {
      const searchOpts = {
        scope: 'base',
        filter: '(objectClass=group)',
        attributes: ['member', 'distinguishedName']
      };
      client.search(groupDN, searchOpts, (err, result) => {
        if (err) return reject(err);
        let obj = null;
        result.on('searchEntry', (e) => {
          obj = {};
          if (e.attributes && Array.isArray(e.attributes)) {
            e.attributes.forEach(a => { obj[a.type] = a.values && a.values.length === 1 ? a.values[0] : (a.values || []); });
          }
        });
        result.on('error', (e) => reject(e));
        result.on('end', () => {
          if (!obj) return resolve(false);
          let members = obj.member || [];
          if (!Array.isArray(members)) members = [members];
          const lowerUserDN = userDN.toLowerCase().replace(/\s/g, '');
          const found = members.some(m => String(m).toLowerCase().replace(/\s/g, '') === lowerUserDN);
          resolve(found);
        });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try { client.unbind(); } catch (_) {}
    }
  }
}

/**
 * Add user to a group
 * @param {string} userDN
 * @param {string} groupDN
 */
async function addUserToGroup(userDN, groupDN) {
  let client;
  try {
    client = await createClient();

    const change = new ldap.Change({
      operation: 'add',
      modification: new ldap.Attribute({
        type: 'member',
        values: [userDN]
      })
    });

    return await new Promise((resolve, reject) => {
      client.modify(groupDN, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'User added to group successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

/**
 * Remove user from a group
 * @param {string} userDN
 * @param {string} groupDN
 */
async function removeUserFromGroup(userDN, groupDN) {
  let client;
  try {
    client = await createClient();

    const change = new ldap.Change({
      operation: 'delete',
      modification: new ldap.Attribute({
        type: 'member',
        values: [userDN]
      })
    });

    return await new Promise((resolve, reject) => {
      client.modify(groupDN, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'User removed from group successfully' });
      });
    });
  } catch (err) {
    throw err;
  } finally {
    if (client) {
      try {
        client.unbind();
      } catch (e) {
        // ignore
      }
    }
  }
}

// ── COMPUTER FUNCTIONS ────────────────────────────────────────────────────
function findComputer(name) {
  return new Promise(async (resolve, reject) => {
    try {
      const client = await createClient();
      const opts = { filter: `(|(cn=${name})(sAMAccountName=${name}))`, scope: 'sub', attributes: ['*'] };
      client.search(adConfig.baseDN, opts, (err, res) => {
        if (err) { client.unbind(); return reject(err); }
        let entry = null;
        res.on('searchEntry', e => {
          if (entry) return;
          const obj = e.object || {};
          if (e.attributes && Array.isArray(e.attributes)) {
            e.attributes.forEach(a => { obj[a.type] = a.values && a.values.length === 1 ? a.values[0] : (a.values || []); });
          }
          if (obj.distinguishedName || obj.objectName) { obj.dn = obj.distinguishedName || obj.objectName; }
          entry = obj;
        });
        res.on('error', (e) => { client.unbind(); reject(e); });
        res.on('end', () => { client.unbind(); resolve(entry); });
      });
    } catch (e) { reject(e); }
  });
}

async function searchComputers(query) {
  const client = await createClient();
  const filter = query ? `(&(objectClass=computer)(|(cn=*${query}*)(sAMAccountName=*${query}*)))` : '(objectClass=computer)';
  return new Promise((resolve, reject) => {
    const all = [];
    client.search(adConfig.baseDN, { filter, scope: 'sub', attributes: ['cn', 'sAMAccountName', 'operatingSystem', 'operatingSystemVersion', 'userAccountControl', 'description', 'whenCreated', 'lastLogon', 'dNSHostName', 'distinguishedName'] }, (err, res) => {
      if (err) { client.unbind(); return reject(err); }
      res.on('searchEntry', e => {
        const obj = e.object || {};
        if (e.attributes && Array.isArray(e.attributes)) {
          e.attributes.forEach(a => { obj[a.type] = a.values && a.values.length === 1 ? a.values[0] : (a.values || []); });
        }
        if (obj.distinguishedName || obj.objectName) { obj.dn = obj.distinguishedName || obj.objectName; }
        if (Object.keys(obj).length > 0) all.push(obj);
      });
      res.on('error', (e) => {
        if (e.name === 'SizeLimitExceededError') { client.unbind(); resolve(all); }
        else { client.unbind(); reject(e); }
      });
      res.on('end', () => { client.unbind(); resolve(all); });
    });
  });
}

async function createComputer(data) {
  return oneShot(async (client) => {
    const cn = data.name || data.cn;
    if (!cn) throw new Error('Computer name (cn) is required');
    const ou = data.ou || adConfig.computersOU || adConfig.usersOU;
    const dn = `CN=${cn},${ou}`;
    const entry = {
      objectClass: ['top', 'person', 'organizationalPerson', 'user', 'computer'],
      cn,
      sAMAccountName: cn + '$',
      userAccountControl: '4096'
    };
    if (data.description) entry.description = data.description;
    return new Promise((resolve, reject) => {
      client.add(dn, entry, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Computer created successfully', dn });
      });
    });
  });
}

async function deleteComputer(dn) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      client.del(dn, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Computer deleted successfully' });
      });
    });
  });
}

async function enableComputer(dn) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      const change = new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: 'userAccountControl', values: ['4096'] }) });
      client.modify(dn, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Computer enabled' });
      });
    });
  });
}

async function disableComputer(dn) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      const change = new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: 'userAccountControl', values: ['4098'] }) });
      client.modify(dn, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Computer disabled' });
      });
    });
  });
}

async function resetComputer(dn) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      const change = new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: 'userAccountControl', values: ['4097'] }) });
      client.modify(dn, change, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Computer account reset' });
      });
    });
  });
}

// ── CONTACT FUNCTIONS ─────────────────────────────────────────────────────
async function findContact(name) {
  const client = await createClient();
  const filter = `(&(objectClass=contact)(|(cn=${name})(mail=${name})))`;
  return new Promise((resolve, reject) => {
    client.search(adConfig.baseDN, { filter, scope: 'sub', attributes: ['*'] }, (err, res) => {
      if (err) { client.unbind(); return reject(err); }
      let entry = null;
      res.on('searchEntry', e => {
        if (entry) return;
        const obj = e.object || {};
        if (e.attributes && Array.isArray(e.attributes)) {
          e.attributes.forEach(a => { obj[a.type] = a.values && a.values.length === 1 ? a.values[0] : (a.values || []); });
        }
        if (obj.distinguishedName || obj.objectName) { obj.dn = obj.distinguishedName || obj.objectName; }
        entry = obj;
      });
      res.on('error', (e) => { client.unbind(); reject(e); });
      res.on('end', () => { client.unbind(); resolve(entry); });
    });
  });
}

async function searchContacts(query) {
  const client = await createClient();
  const filter = query ? `(&(objectClass=contact)(|(cn=*${query}*)(mail=*${query}*)(displayName=*${query}*)))` : '(objectClass=contact)';
  return new Promise((resolve, reject) => {
    const all = [];
    client.search(adConfig.baseDN, { filter, scope: 'sub', attributes: ['cn', 'displayName', 'mail', 'telephoneNumber', 'title', 'department', 'company', 'distinguishedName', 'whenCreated'] }, (err, res) => {
      if (err) { client.unbind(); return reject(err); }
      res.on('searchEntry', e => {
        const obj = e.object || {};
        if (e.attributes && Array.isArray(e.attributes)) {
          e.attributes.forEach(a => { obj[a.type] = a.values && a.values.length === 1 ? a.values[0] : (a.values || []); });
        }
        if (obj.distinguishedName || obj.objectName) { obj.dn = obj.distinguishedName || obj.objectName; }
        if (Object.keys(obj).length > 0) all.push(obj);
      });
      res.on('error', (e) => {
        if (e.name === 'SizeLimitExceededError') { client.unbind(); resolve(all); }
        else { client.unbind(); reject(e); }
      });
      res.on('end', () => { client.unbind(); resolve(all); });
    });
  });
}

async function createContact(data) {
  return oneShot(async (client) => {
    const cn = data.cn || data.name;
    if (!cn) throw new Error('Contact name (cn) is required');
    const ou = data.ou || adConfig.usersOU;
    const dn = `CN=${cn},${ou}`;
    const entry = { objectClass: ['top', 'contact'], cn };
    if (data.displayName) entry.displayName = data.displayName;
    if (data.mail) entry.mail = data.mail;
    if (data.telephoneNumber) entry.telephoneNumber = data.telephoneNumber;
    if (data.title) entry.title = data.title;
    if (data.department) entry.department = data.department;
    if (data.company) entry.company = data.company;
    if (data.mobile) entry.mobile = data.mobile;
    if (data.facsimileTelephoneNumber) entry.facsimileTelephoneNumber = data.facsimileTelephoneNumber;
    if (data.streetAddress) entry.streetAddress = data.streetAddress;
    if (data.l) entry.l = data.l;
    if (data.st) entry.st = data.st;
    if (data.postalCode) entry.postalCode = data.postalCode;
    if (data.co) entry.co = data.co;
    if (data.notes) entry.notes = data.notes;
    return new Promise((resolve, reject) => {
      client.add(dn, entry, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Contact created successfully', dn });
      });
    });
  });
}

async function updateContact(dn, attributes) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      const changes = [];
      for (const [key, val] of Object.entries(attributes)) {
        if (val === null || val === '') {
          changes.push(new ldap.Change({ operation: 'delete', modification: new ldap.Attribute({ type: key, values: [] }) }));
        } else {
          changes.push(new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: key, values: [String(val)] }) }));
        }
      }
      client.modify(dn, changes, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Contact updated successfully' });
      });
    });
  });
}

async function deleteContact(dn) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      client.del(dn, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Contact deleted successfully' });
      });
    });
  });
}

// ── OU FUNCTIONS ──────────────────────────────────────────────────────────
async function searchOUs(query) {
  const client = await createClient();
  const filter = query ? `(&(objectClass=organizationalUnit)(name=*${query}*))` : '(objectClass=organizationalUnit)';
  try {
    return new Promise((resolve, reject) => {
      const all = [];
      client.search(adConfig.baseDN, { filter, scope: 'sub', attributes: ['cn', 'ou', 'name', 'distinguishedName', 'description', 'whenCreated'] }, (err, res) => {
        if (err) return reject(err);
        res.on('searchEntry', e => {
          const rawDn = String(e.objectName || e.dn || '');
          const obj = { dn: rawDn };
          if (e.attributes && Array.isArray(e.attributes)) {
            e.attributes.forEach(a => {
              if (a.type === 'dn' || a.type === 'distinguishedName') return;
              const val = a.values && a.values.length === 1 ? a.values[0] : (a.values || []);
              obj[a.type] = val;
            });
          }
          if (!obj.name) obj.name = obj.ou || obj.cn || (rawDn ? rawDn.split(',').find(p => p.startsWith('OU='))?.replace('OU=', '') : '') || '';
          all.push(obj);
        });
        res.on('error', reject);
        res.on('end', () => { client.unbind(); resolve(all); });
      });
    });
  } catch (e) { client.unbind(); throw e; }
}

async function createOU(data) {
  return oneShot(async (client) => {
    const name = data.name || data.cn;
    if (!name) throw new Error('OU name is required');
    const parent = data.parentDN || adConfig.baseDN;
    const dn = `OU=${name},${parent}`;
    const entry = { objectClass: ['top', 'organizationalUnit'], ou: name };
    if (data.description) entry.description = data.description;
    return new Promise((resolve, reject) => {
      client.add(dn, entry, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'OU created successfully', dn });
      });
    });
  });
}

async function deleteOU(dn) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      client.del(dn, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'OU deleted successfully' });
      });
    });
  });
}

// ── GROUP CRUD ────────────────────────────────────────────────────────────
async function createGroup(data) {
  return oneShot(async (client) => {
    const cn = data.name || data.cn;
    if (!cn) throw new Error('Group name (cn) is required');
    const ou = data.ou || adConfig.usersOU;
    const dn = `CN=${cn},${ou}`;
    const groupType = data.type === 'distribution' ? '2' : (data.scope === 'universal' ? '8' : data.scope === 'domainlocal' ? '4' : '2');
    const entry = {
      objectClass: ['top', 'group'],
      cn,
      sAMAccountName: cn,
      groupType: groupType
    };
    if (data.description) entry.description = data.description;
    if (data.mail) entry.mail = data.mail;
    if (data.displayName) entry.displayName = data.displayName;
    return new Promise((resolve, reject) => {
      client.add(dn, entry, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Group created successfully', dn });
      });
    });
  });
}

async function deleteGroup(dn) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      client.del(dn, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Group deleted successfully' });
      });
    });
  });
}

async function updateGroup(dn, attributes) {
  return oneShot(async (client) => {
    return new Promise((resolve, reject) => {
      const changes = [];
      for (const [key, val] of Object.entries(attributes)) {
        if (val === null || val === '') {
          changes.push(new ldap.Change({ operation: 'delete', modification: new ldap.Attribute({ type: key, values: [] }) }));
        } else {
          changes.push(new ldap.Change({ operation: 'replace', modification: new ldap.Attribute({ type: key, values: [String(val)] }) }));
        }
      }
      client.modify(dn, changes, (err) => {
        if (err) return reject(err);
        resolve({ success: true, message: 'Group updated successfully' });
      });
    });
  });
}

async function getADHealth() {
  const client = await createClient();
  return new Promise((resolve, reject) => {
    const results = { domain: adConfig.baseDN, server: adConfig.url, status: 'connected', lastCheck: new Date().toISOString(), fsmo: {}, replication: [] };
    // Get rootDSE for server info
    client.search('', { scope: 'base', attributes: ['*'] }, (err, res) => {
      if (err) { results.status = 'error'; results.error = err.message; client.unbind(); return resolve(results); }
      res.on('searchEntry', e => {
        const attrs = {};
        if (e.attributes) e.attributes.forEach(a => { attrs[a.type] = a.values; });
        results.fsmo = {
          schemaMaster: (attrs.fsmoRoleOwner?.[0] || '').split(',')[0].replace('CN=',''),
          pdcEmulator: (attrs.fsmoRoleOwner?.[0] || '').split(',')[0].replace('CN=',''),
          ridMaster: (attrs.fsmoRoleOwner?.[0] || '').split(',')[0].replace('CN=',''),
          infrastructureMaster: (attrs.fsmoRoleOwner?.[0] || '').split(',')[0].replace('CN=',''),
          domainNamingMaster: (attrs.fsmoRoleOwner?.[0] || '').split(',')[0].replace('CN=','')
        };
        results.server = attrs.dnsHostName?.[0] || adConfig.url;
      });
      res.on('end', () => { client.unbind(); resolve(results); });
      res.on('error', e => { results.status = 'error'; results.error = e.message; client.unbind(); resolve(results); });
    });
  });
}

function ldapQuery(objectClass, customFilter, attributes) {
  return new Promise((resolve, reject) => {
    const filter = customFilter || `(objectClass=${objectClass})`;
    const attrs = attributes && attributes.length ? attributes : ['*'];
    const client = createClient();
    client.then(c => {
      c.search(adConfig.baseDN, { filter, scope: 'sub', attributes: attrs }, (err, res) => {
        if (err) { c.unbind(); return reject(err); }
        const results = [];
        res.on('searchEntry', e => {
          const obj = { dn: e.objectName || '' };
          if (e.attributes) e.attributes.forEach(a => { obj[a.type] = a.values && a.values.length === 1 ? a.values[0] : (a.values || []); });
          results.push(obj);
        });
        res.on('end', () => { c.unbind(); resolve(results); });
        res.on('error', e => { c.unbind(); reject(e); });
      });
    }).catch(reject);
  });
}

function readAttribute(dn, attribute) {
  return new Promise((resolve, reject) => {
    const client = createClient();
    client.then(c => {
      c.search(dn, { scope: 'base', attributes: [attribute] }, (err, res) => {
        if (err) { c.unbind(); return reject(err); }
        res.on('searchEntry', e => {
          c.unbind();
          if (e.attributes) {
            const a = e.attributes.find(x => x.type === attribute);
            return resolve(a ? (a.values && a.values.length === 1 ? a.values[0] : a.values) : null);
          }
          resolve(null);
        });
        res.on('error', e => { c.unbind(); reject(e); });
        res.on('end', () => { c.unbind(); resolve(null); });
      });
    }).catch(reject);
  });
}

function writeAttribute(dn, attribute, value) {
  return oneShot(async (client) => {
    const change = new ldap.Change({
      operation: 'replace',
      modification: new ldap.Attribute({ type: attribute, values: [String(value)] })
    });
    await new Promise((resolve, reject) => {
      client.modify(dn, change, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    return { success: true, message: `Attribute ${attribute} updated` };
  });
}

function getDeletedObjects() {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url: adConfig.url });
    client.bind(adConfig.username, adConfig.password, (err) => {
      if (err) { client.unbind(); return reject(err); }
      const attrs = ['cn', 'name', 'objectClass', 'lastKnownParent', 'whenChanged', 'distinguishedName', 'isDeleted', 'sAMAccountName'];
      const all = [];
      let cookie = Buffer.alloc(0);
      function doSearch() {
        client.search(adConfig.baseDN, {
          filter: '(isDeleted=TRUE)',
          scope: 'sub',
          attributes: attrs,
          paged: { pageSize: 1000, cookie: cookie }
        }, [new ldap.Control({ type: '1.2.840.113556.1.4.417', criticality: true })], (err, res) => {
          if (err) { client.unbind(); return reject(err); }
          res.on('searchEntry', e => {
            const obj = { name: '', type: '', originalDN: '', deletedAt: null, dn: String(e.objectName || ''), sam: '' };
            if (e.attributes) {
              e.attributes.forEach(a => {
                let val = a.values && a.values.length === 1 ? a.values[0] : (a.values || []);
                if (Buffer.isBuffer(val)) val = val.toString('utf8');
                if (a.type === 'cn' || a.type === 'name') {
                  obj.name = (val || '').replace(/\nDEL:[^,]*/, '');
                }
                if (a.type === 'objectClass') {
                  const cls = Array.isArray(val) ? val.find(v => v !== 'top') : val;
                  obj.type = cls === 'person' ? 'user' : (cls || '');
                }
                if (a.type === 'lastKnownParent') obj.originalDN = val || '';
                if (a.type === 'whenChanged') obj.deletedAt = val || '';
                if (a.type === 'distinguishedName' && !obj.originalDN) obj.originalDN = val || '';
              });
            }
            if (obj.name !== 'Deleted Objects') all.push(obj);
          });
          res.on('end', () => {
            if (res.cookie && res.cookie.length > 0) {
              cookie = res.cookie;
              doSearch();
            } else {
              client.unbind();
              resolve(all);
            }
          });
          res.on('error', e => { client.unbind(); reject(e); });
        });
      }
      doSearch();
    });
  });
}

function restoreDeletedObject(dn, parentDN) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    if (!dn) return reject(new Error('Object DN is required'));

    // Extract the clean CN from the tombstone DN. Tombstone DNs contain a
    // control byte (0x00 or 0x0A) followed by 'aDEL:<guid>' or just 'DEL:'.
    // Strip everything from that marker and remove remaining control chars.
    const cnMatch = dn.match(/^CN=([^,]+)/);
    const cn = cnMatch
      ? cnMatch[1]
          .replace(/[\x00\x0A]a?DEL:.*$/, '')
          .replace(/[\x00-\x1F]/g, '')
          .trim()
      : '';
    if (!cn) return reject(new Error('Could not determine object name from DN'));

    const b64CN = Buffer.from(cn, 'utf8').toString('base64');
    const b64Parent = Buffer.from(parentDN || '', 'utf8').toString('base64');
    const defaultContainer = `CN=Users,${adConfig.baseDN}`;
    const b64Default = Buffer.from(defaultContainer, 'utf8').toString('base64');

    const psScript = `$ProgressPreference = 'SilentlyContinue'
$cn = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64CN}'))
$parent = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Parent}'))
$defaultContainer = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64Default}'))

# Find the deleted object by clean name wildcard
$obj = Get-ADObject -LDAPFilter ('(name=' + $cn + '*)') -IncludeDeletedObjects | Select-Object -First 1
if (-not $obj) {
  # Fallback: try cn attribute
  $obj = Get-ADObject -LDAPFilter ('(cn=' + $cn + '*)') -IncludeDeletedObjects | Select-Object -First 1
}
if (-not $obj) { Write-Error 'Object not found' }
else {
  # Validate target container; fall back to default Users if missing
  $target = $parent
  if (-not $parent) { $target = $defaultContainer }
  else {
    try { $null = Get-ADObject -Identity $parent -ErrorAction Stop }
    catch { $target = $defaultContainer }
  }
  try {
    $null = Restore-ADObject -Identity $obj.DistinguishedName -TargetPath $target -Confirm:$false -ErrorAction Stop
    Write-Output 'SUCCESS'
  } catch {
    Write-Error ('Restore failed: ' + $_.Exception.Message)
  }
}`;
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 15000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0 || !stdout.includes('SUCCESS')) return reject(new Error(stderr.trim() || 'Restore failed'));
      resolve({ success: true, message: 'Object restored successfully' });
    });
    proc.on('error', err => reject(err));
  });
}

module.exports = {
  authenticateUser,
  findUser,
  getAllUsers,
  getTotalUserCount,
  searchUsers,
  getAllGroups,
  getGroupMembers,
  getUserGroups,
  createUser,
  disableUser,
  enableUser,
  resetPassword,
  updateUser,
  deleteUser,
  moveUser,
  addUserToGroup,
  removeUserFromGroup,
  isUserInGroup,
  findComputer, searchComputers, getAllComputers, getTotalComputerCount, createComputer, deleteComputer, enableComputer, disableComputer, resetComputer,
  findContact, searchContacts, createContact, updateContact, deleteContact,
  searchOUs, createOU, deleteOU,
  createGroup, deleteGroup, updateGroup,
  dateToADFiletime,
  findUserFull,
  getADHealth,
  createGMSA,
  ldapQuery, readAttribute, writeAttribute, getDeletedObjects, restoreDeletedObject
};
