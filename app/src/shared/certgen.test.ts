import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateCaCert, generateSelfSignedCert, generateServerCertSignedByCa } from "./certgen.ts";

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
});
