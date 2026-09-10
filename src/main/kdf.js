const crypto = require('crypto');
const { SCRYPT } = require('../shared/secure-channel');

// scrypt with the protocol's parameters. Pairing codes and passwords are only ever compared as
// scrypt-derived, transcript-bound proofs, so an eavesdropper can't replay or cheaply guess them.
function scrypt(secret, salt, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p, dkLen = SCRYPT.dkLen } = {}) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(secret), Buffer.from(salt), dkLen, { N, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err);
      else resolve(new Uint8Array(key));
    });
  });
}

function scryptSync(secret, salt, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p, dkLen = SCRYPT.dkLen } = {}) {
  return new Uint8Array(crypto.scryptSync(Buffer.from(secret), Buffer.from(salt), dkLen, { N, r, p, maxmem: 256 * 1024 * 1024 }));
}

module.exports = { scrypt, scryptSync };
