const { ClientSecretCredential } = require('@azure/identity');
const { Client } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');
const graphConfig = require('../config/graph.config');

// ── Build Graph client ──────────────────────────────────────────────────────
function getGraphClient() {
  const credential = new ClientSecretCredential(
    graphConfig.tenantId,
    graphConfig.clientId,
    graphConfig.clientSecret
  );

  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: graphConfig.scopes
  });

  return Client.initWithMiddleware({ authProvider });
}

// ════════════════════════════════════════════════════════════════════════════
// USER OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get Azure AD user by UPN or ID
 */
async function getAzureUser(upn) {
  const client = getGraphClient();
  return await client.api(`/users/${upn}`).get();
}

/**
 * Get all Azure AD users
 */
async function getAllAzureUsers() {
  const client = getGraphClient();
  return await client.api('/users')
    .select('id,displayName,userPrincipalName,mail,department,jobTitle,accountEnabled,assignedLicenses')
    .get();
}

// ════════════════════════════════════════════════════════════════════════════
// LICENSE OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get all available licenses in the tenant
 */
async function getAvailableLicenses() {
  const client = getGraphClient();
  return await client.api('/subscribedSkus').get();
}

/**
 * Get licenses assigned to a user
 */
async function getUserLicenses(upn) {
  const client = getGraphClient();
  const user = await client.api(`/users/${upn}`)
    .select('assignedLicenses,assignedPlans')
    .get();
  return user.assignedLicenses;
}

/**
 * Assign a license to a user
 * @param {string} upn
 * @param {string} skuId - License SKU ID from getAvailableLicenses()
 */
async function assignLicense(upn, skuId) {
  const client = getGraphClient();
  return await client.api(`/users/${upn}/assignLicense`).post({
    addLicenses: [{ skuId }],
    removeLicenses: []
  });
}

/**
 * Remove a license from a user
 * @param {string} upn
 * @param {string} skuId
 */
async function removeLicense(upn, skuId) {
  const client = getGraphClient();
  return await client.api(`/users/${upn}/assignLicense`).post({
    addLicenses: [],
    removeLicenses: [skuId]
  });
}

// ════════════════════════════════════════════════════════════════════════════
// MAILBOX OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get mailbox settings for a user
 */
async function getMailboxSettings(upn) {
  const client = getGraphClient();
  return await client.api(`/users/${upn}/mailboxSettings`).get();
}

/**
 * Set out-of-office / auto reply
 */
async function setAutoReply(upn, message, enabled = true) {
  const client = getGraphClient();
  return await client.api(`/users/${upn}/mailboxSettings`).patch({
    automaticRepliesSetting: {
      status: enabled ? 'alwaysEnabled' : 'disabled',
      internalReplyMessage: message,
      externalReplyMessage: message
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// MFA / SECURITY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get MFA methods for a user
 */
async function getUserMFAMethods(upn) {
  const client = getGraphClient();
  return await client.api(`/users/${upn}/authentication/methods`).get();
}

/**
 * Revoke all sign-in sessions for a user (force re-login)
 */
async function revokeUserSessions(upn) {
  const client = getGraphClient();
  return await client.api(`/users/${upn}/revokeSignInSessions`).post({});
}

// ════════════════════════════════════════════════════════════════════════════
// GROUPS (Azure AD)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get all Azure AD groups
 */
async function getAzureGroups() {
  const client = getGraphClient();
  return await client.api('/groups')
    .select('id,displayName,description,groupTypes,mail')
    .get();
}

/**
 * Get members of an Azure AD group
 */
async function getAzureGroupMembers(groupId) {
  const client = getGraphClient();
  return await client.api(`/groups/${groupId}/members`).get();
}

module.exports = {
  getAzureUser,
  getAllAzureUsers,
  getAvailableLicenses,
  getUserLicenses,
  assignLicense,
  removeLicense,
  getMailboxSettings,
  setAutoReply,
  getUserMFAMethods,
  revokeUserSessions,
  getAzureGroups,
  getAzureGroupMembers
};
