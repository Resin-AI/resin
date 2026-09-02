/**
 * Production release trust roots bundled into locally built and packaged CLIs.
 * Retains the existing 2026a root and pins the v1 public release signing key.
 */
export const PRODUCTION_RELEASE_TRUST_RECORD = Object.freeze({
  schemaVersion: "2.0.0",
  trustDomain: "production",
  trustedKeys: Object.freeze([
    Object.freeze({
      keyId: "resin-release-2026a",
      algorithm: "Ed25519",
      trustDomain: "production",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA9ZI1qv+S+txsMLDf1WylTCionlq7H6V6t9XqaD1geFE=\n-----END PUBLIC KEY-----\n",
      publicKeyHex: "f59235aaff92fadc6c30b0dfd56ca54c28a89e5abb1fa57ab7d5ea683d607851",
      publicKeyFingerprintSha256:
        "a702d0d424e5797ecb672afabd275548c1ef6e1e95d1ea9651916e147e784359",
    }),
    Object.freeze({
      keyId: "resin-public-release-v1",
      algorithm: "Ed25519",
      trustDomain: "production",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAD6LyeD/8rL8fscAs8B0okBXGRI0PCrGIbecGo5lV0gQ=\n-----END PUBLIC KEY-----\n",
      publicKeyHex: "0fa2f2783ffcacbf1fb1c02cf01d289015c6448d0f0ab1886de706a39955d204",
      publicKeyFingerprintSha256:
        "54a0077e1353cd20f2c4d4eab5dd0d9d883a5e814c6992f61287ef544255836f",
    }),
  ]),
});
