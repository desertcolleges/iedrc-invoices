const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/Code.gs`, 'utf8');

function authenticate(email, domain = 'example.edu') {
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => domain }) },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
  };
  return vm.runInNewContext(`${source}\nrequireUser_()`, context);
}

test('accepts a signed-in user from the configured Workspace domain', () => {
  assert.equal(authenticate('Approver@Example.edu').email, 'approver@example.edu');
});

test('rejects users with no email or from another domain', () => {
  assert.throws(() => authenticate(''), /not authorized/);
  assert.throws(() => authenticate('user@other.edu'), /not authorized/);
});

test('requires ALLOWED_DOMAIN to be configured', () => {
  assert.throws(() => authenticate('user@example.edu', ''), /ALLOWED_DOMAIN/);
});
