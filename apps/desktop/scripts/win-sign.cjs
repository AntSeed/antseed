// electron-builder custom Windows sign hook (win.sign). The code-signing
// private key lives in the CA's cloud HSM (mandatory under current CA/B
// rules — there is no local .pfx); the CA's signing service is a plain
// HTTPS API with TOTP login, so signing needs no desktop app, no
// smart-card stack, and no persistent session — each release run
// authenticates itself from the TOTP seed.
//
// The protocol work (login, certificate fetch, Authenticode PKCS#7
// assembly, RFC3161 timestamp) is done by the `ssign` CLI, which the
// release workflow builds from a pinned, security-reviewed revision.
//
// Required env (set as GitHub secrets in the release workflow):
//   WIN_SIGN_EMAIL  signing service account e-mail
//   WIN_SIGN_OTP    TOTP seed (base32 or full otpauth:// URI). Long-lived
//                   signing credential — keep it in a protected environment.
//   SSIGN_PATH      optional path to the ssign binary (defaults to
//                   `ssign` on PATH)
//
// When WIN_SIGN_EMAIL / WIN_SIGN_OTP are absent the hook is a no-op, so
// unsigned local/dev builds keep working exactly as before.
//
// ssign caches its session (~20 min) between invocations, so although
// electron-builder calls this hook once per file, only the first call
// performs a TOTP login — later calls reuse the session instead of
// burning (and re-using, which the service rejects) TOTP codes.
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

let warnedSkip = false;

module.exports = async function sign(configuration) {
  const { WIN_SIGN_EMAIL, WIN_SIGN_OTP } = process.env;

  if (!WIN_SIGN_EMAIL || !WIN_SIGN_OTP) {
    if (!warnedSkip) {
      console.log(
        '  • WIN_SIGN_EMAIL / WIN_SIGN_OTP not set — skipping Windows code signing'
      );
      warnedSkip = true;
    }
    return;
  }

  const file = configuration.path;
  console.log(`  • win-sign: signing ${path.basename(file)}`);
  execFileSync(
    process.env.SSIGN_PATH || 'ssign',
    // Default RFC3161 TSA (http:// — the TSA serves no TLS; timestamp
    // integrity comes from its own signature, per usual for RFC3161).
    ['-n', 'AntSeed Desktop', '-u', 'https://antseed.com', file],
    // Secrets flow via env vars, never argv. Signs in place. ssign reads
    // its account/seed from CERTUM_EMAIL/CERTUM_OTP.
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CERTUM_EMAIL: WIN_SIGN_EMAIL,
        CERTUM_OTP: WIN_SIGN_OTP,
      },
    }
  );
};
