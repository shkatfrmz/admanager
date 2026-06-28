require('dotenv').config();

module.exports = {
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  scopes: ['https://graph.microsoft.com/.default']
};
