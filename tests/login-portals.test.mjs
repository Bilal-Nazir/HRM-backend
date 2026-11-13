import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function load(file, mocks) {
  const scope = { exports: {}, require: (name) => mocks[name] || require(name) };
  runInNewContext(ts.transpileModule(readFileSync(new URL('../src/AuthModule/' + file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, scope);
  return scope.exports;
}
class UnauthenticatedException extends Error {}
class ValidationException extends Error {}
const utils = { UnauthenticatedException, ValidationException };
const portal = load('utils/loginPortal.ts', { '../../node-base/utils': utils });
test('only the platform flag selects the admin login, including users with no company', () => {
  portal.assertLoginPortal('employee', false); portal.assertLoginPortal('admin', true);
  assert.throws(() => portal.assertLoginPortal('admin', false), /Only Super Admin/);
  assert.throws(() => portal.assertLoginPortal('employee', true), /Super Admin accounts/);
  for (const value of [null, '', 'superadmin', {}, 1]) assert.throws(() => portal.assertLoginPortal(value, false), ValidationException);
});
function googleFixture(user, linked = true) {
  const writes = [], sessions = [];
  const models = {
    findOne(filter) { return { async select() { return filter.googleSubject && !linked ? null : user; } }; },
    async create() { writes.push('create'); return user; },
    async findOneAndUpdate() { writes.push('link'); return user; },
  };
  const controller = load('controllers/AuthController.ts', {
    '../../node-base/utils': utils,
    '../../node-base/baseClasses': { BaseControllerClass: class {} },
    '../../node-base/constants': { constants: { fields: { User: { User: 'user' } } } },
    '../../node-base/validator': {},
    '../models/User': { __esModule: true, default: models },
    '../utils/loginPortal': portal,
    '../utils/googleIdentity': { async verifyGoogleCredential() { return { subject: 'google-subject', email: 'person@gmail.com' }; } },
    '../utils/password': { async verifyPassword() { return true; } },
    '../utils/session': {},
    '../../TenantModule/services/companyContext': {},
    '../../TenantModule/controllers/CompanyController': { async sendCompanySession(_req, _res, value) { sessions.push(value); return value; } },
    '../../TenantModule/models/CompanyMembership': {},
    '../../EmployeeModule/models/Employee': {},
    '../../OrganizationModule/models/Organization': {},
    '../../AccessModule/models/RoleAssignment': {},
  }).default;
  controller.defaultCompany = async () => undefined;
  return { writes, sessions, signIn: (value) => controller.googleLoginController({ body: { portal: value, credential: 'verified-in-fixture', nonce: 'verified-in-fixture', existingPassword: 'correct' } }, {}) };
}
test('Google admin login cannot create or link company accounts, or accept existing company Google accounts', async () => {
  for (const user of [null, { id: 'owner', isPlatformAdmin: false, isActive: true, passwordHash: 'hash' }]) {
    for (const linked of [false, true]) {
      const f = googleFixture(user, linked);
      await assert.rejects(f.signIn('admin'), /Only Super Admin/);
      assert.deepEqual(f.writes, []); assert.deepEqual(f.sessions, []);
    }
  }
});
test('Google routes existing Super Admin and company identities through their respective login pages', async () => {
  const platform = { id: 'platform', isPlatformAdmin: true, isActive: true };
  const owner = { id: 'owner', isCompanyOwner: true, isPlatformAdmin: false, isActive: true };
  const f = googleFixture(platform); await assert.rejects(f.signIn('employee'), /Super Admin accounts/); assert.equal(f.sessions.length, 0);
  assert.equal((await f.signIn('admin')).id, 'platform');
  const company = googleFixture(owner); assert.equal((await company.signIn('employee')).id, 'owner'); assert.equal(company.sessions.length, 1);
});
