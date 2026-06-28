const ldap = require('ldapjs');

const client = ldap.createClient({
  url: 'ldap://DC.labnet.local'
});

client.bind('sysadmin@labnet.local', 'YourPasswordHere', (err) => {
  if (err) {
    console.log('Authentication failed:', err);
  } else {
    console.log('Authentication successful');
  }
  client.unbind();
});