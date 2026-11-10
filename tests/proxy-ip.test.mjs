import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import express from "express";
import ts from "typescript";

const scope = { exports: {}, process: { env: {} } };
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/server/proxyTrust.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, scope);
const { trustProxyRanges } = scope.exports;
function requestIp(peer, forwarded, setting = trustProxyRanges()) {
  const app = express();
  app.set("trust proxy", setting);
  const req = Object.create(app.request);
  req.socket = { remoteAddress: peer };
  req.headers = forwarded ? { "x-forwarded-for": forwarded } : {};
  return req.ip;
}

test("private Caddy and Nginx proxy chain preserves the public client IP", () => {
  assert.equal(requestIp("172.18.0.4", "8.8.8.8, 172.18.0.1"), "8.8.8.8");
  assert.equal(requestIp("::ffff:172.18.0.4", "2606:4700:4700::1111, 172.18.0.1"), "2606:4700:4700::1111");
});

test("direct public clients and spoofed leftmost forwarded entries cannot replace the observed client", () => {
  assert.equal(requestIp("8.8.8.8", "1.1.1.1"), "8.8.8.8");
  assert.equal(requestIp("172.18.0.4", "1.1.1.1, 8.8.8.8, 172.18.0.1"), "8.8.8.8");
});

test("proxy trust can be disabled or restricted to explicit deployment CIDRs", () => {
  assert.equal(requestIp("172.18.0.4", "8.8.8.8", trustProxyRanges("false")), "172.18.0.4");
  assert.equal(requestIp("172.18.0.4", "8.8.8.8", trustProxyRanges("172.18.0.4/32")), "8.8.8.8");
  assert.equal(requestIp("172.18.0.5", "8.8.8.8", trustProxyRanges("172.18.0.4/32")), "172.18.0.5");
});

test("AWS edge overwrites untrusted forwarding headers and Caddy is private with strict parsing", () => {
  const nginx = readFileSync(new URL("../deploy/nginx.aws.conf", import.meta.url), "utf8");
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
  const caddy = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
  assert.match(caddy, /trusted_proxies_strict/);
  assert.match(caddy, /CADDY_TRUSTED_PROXIES:127\.0\.0\.1\/32/);
  const compose = readFileSync(new URL("../deploy/compose.aws.yaml", import.meta.url), "utf8");
  assert.match(compose, /127\.0\.0\.1:18080:80/);
  assert.match(compose, /CADDY_TRUSTED_PROXIES: "private_ranges"/);
});
