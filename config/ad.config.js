require('dotenv').config();

module.exports = {
  // For read operations with ActiveDirectory library (uses regular LDAP)
  url: process.env.AD_URL || `ldap://${process.env.AD_SERVER}`,
  baseDN: process.env.AD_BASE_DN,
  username: process.env.AD_USERNAME || "",
  password: process.env.AD_PASSWORD || "",
  usersOU: process.env.AD_USERS_OU || "",

  // ldapjs client options - use LDAPS for write operations (required for password changes)
  ldapOptions: {
    // Prefer an explicit AD_WRITE_URL, otherwise upgrade the read URL to LDAPS
    url: process.env.AD_WRITE_URL || (process.env.AD_URL && process.env.AD_URL.replace(/^ldap:/i, 'ldaps:')),
    tlsOptions: {
      rejectUnauthorized: false // set true in production with proper cert
    },
    reconnect: true
  }
};