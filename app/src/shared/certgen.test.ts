import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { downloadTextFile, generateCaCert, generateSelfSignedCert, generateServerCertSignedByCa, textFileSaveRequest } from "./certgen.ts";

describe("certgen", () => {
  test("self-signed pem markers", async () => {
    const bundle = await generateSelfSignedCert({ commonName: "Test Local", daysValid: 30 });
    assert.match(bundle.certPem, /BEGIN CERTIFICATE/);
    assert.match(bundle.keyPem, /BEGIN PRIVATE KEY/);
  });

  test("ca signs server cert", async () => {
    const ca = await generateCaCert("Test CA", 365);
    const server = await generateServerCertSignedByCa({
      commonName: "localhost",
      daysValid: 90,
      ca: ca.ca,
    });
    assert.match(server.certPem, /BEGIN CERTIFICATE/);
    assert.notEqual(server.certPem, ca.certPem);
  });

  test("pub and pem share one save-dialog request", () => {
    const pub = textFileSaveRequest("id_ed25519_work.pub");
    const pem = textFileSaveRequest("id_rsa_work.pem");
    assert.equal(pub.defaultPath, "id_ed25519_work.pub");
    assert.deepEqual(pub.filters, [{ name: "OpenSSH public key", extensions: ["pub"] }]);
    assert.equal(pem.defaultPath, "id_rsa_work.pem");
    assert.deepEqual(pem.filters, [{ name: "PEM", extensions: ["pem"] }]);
    assert.equal(textFileSaveRequest("C:\\temp\\id_ed25519_a.pub").defaultPath, "id_ed25519_a.pub");
  });

  test("download does not pretend success when no browser or desktop shell is available", async () => {
    assert.equal(await downloadTextFile("id_ed25519_a.pub", "ssh-ed25519 AAAA comment\n"), false);
  });
});
