const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/Code.gs`, 'utf8');
const validClaims = {
  aud: 'invoice-app-client-id',
  email: 'approver@example.edu',
  email_verified: 'true',
  exp: '4102444800',
  hd: 'example.edu',
  iss: 'https://accounts.google.com',
};

function authenticate(claims, overrides = {}) {
  const properties = {
    GOOGLE_CLIENT_ID: 'invoice-app-client-id',
    ALLOWED_DOMAIN: 'example.edu',
    ...overrides,
  };
  const context = {
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: name => properties[name] || null }),
    },
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(claims),
      }),
    },
  };
  return vm.runInNewContext(
    `${source}\nrequireUser_('${'x'.repeat(120)}')`,
    context
  );
}

test('accepts a verified Google ID token for the configured Workspace domain', () => {
  const user = authenticate(validClaims);
  assert.equal(user.email, validClaims.email);
});

test('rejects tokens issued for a different app or Workspace domain', () => {
  assert.throws(() => authenticate({ ...validClaims, aud: 'another-client-id' }), /not authorized/);
  assert.throws(() => authenticate({ ...validClaims, hd: 'other.edu' }), /not authorized/);
  assert.throws(() => authenticate({ ...validClaims, email: 'user@other.edu' }), /not authorized/);
});

test('rejects unverified, expired, or non-Google identity tokens', () => {
  assert.throws(() => authenticate({ ...validClaims, email_verified: 'false' }), /not authorized/);
  assert.throws(() => authenticate({ ...validClaims, exp: '1' }), /not authorized/);
  assert.throws(() => authenticate({ ...validClaims, iss: 'untrusted.example' }), /not authorized/);
});
