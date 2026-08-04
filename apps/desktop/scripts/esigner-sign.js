// electron-builder custom Windows sign hook (win.sign) that signs via
// SSL.com eSigner cloud signing using CodeSignTool. Since June 2023,
// code-signing private keys must live on certified hardware, so there is
// no local .pfx — the key stays in SSL.com's cloud HSM and CodeSignTool
// signs remotely.
//
// Required env (set as GitHub secrets in the release workflow):
//   ES_USERNAME        SSL.com account username
//   ES_PASSWORD        SSL.com account password
//   ES_CREDENTIAL_ID   eSigner signing credential id
//   ES_TOTP_SECRET     base64 TOTP secret ("show secret code" during
//                      eSigner enrollment) — lets CI generate OTPs
//   CODE_SIGN_TOOL_PATH  directory of an extracted CodeSignTool install
//                        (the one containing CodeSignTool.bat and jar/)
//
// When the ES_* variables are absent the hook is a no-op, so unsigned
// local/dev builds keep working exactly as before.
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let warnedSkip = false;

module.exports = async function sign(configuration) {
  const {
    ES_USERNAME,
    ES_PASSWORD,
    ES_CREDENTIAL_ID,
    ES_TOTP_SECRET,
    CODE_SIGN_TOOL_PATH,
  } = process.env;

  if (!ES_USERNAME || !ES_PASSWORD || !ES_CREDENTIAL_ID || !ES_TOTP_SECRET) {
    if (!warnedSkip) {
      console.log('  • eSigner secrets not set — skipping Windows code signing');
      warnedSkip = true;
    }
    return;
  }
  if (!CODE_SIGN_TOOL_PATH) {
    throw new Error(
      'ES_* secrets are set but CODE_SIGN_TOOL_PATH is not. ' +
        'Point it at an extracted CodeSignTool directory.'
    );
  }

  // Invoke the jar directly instead of CodeSignTool.bat: spawning .bat
  // files requires a shell, and shell quoting would mangle passwords with
  // special characters. The jar still needs CODE_SIGN_TOOL_PATH in the
  // env to locate its conf/ directory.
  const jarDir = path.join(CODE_SIGN_TOOL_PATH, 'jar');
  const jar = fs.readdirSync(jarDir).find((f) => f.endsWith('.jar'));
  if (!jar) {
    throw new Error(`No CodeSignTool jar found in ${jarDir}`);
  }

  const filePath = configuration.path;
  // CodeSignTool writes the signed file to an output dir; sign into a
  // temp dir and copy back over the original.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esigner-'));
  try {
    console.log(`  • eSigner signing ${path.basename(filePath)}`);
    execFileSync(
      'java',
      [
        '-jar',
        path.join(jarDir, jar),
        'sign',
        `-username=${ES_USERNAME}`,
        `-password=${ES_PASSWORD}`,
        `-credential_id=${ES_CREDENTIAL_ID}`,
        `-totp_secret=${ES_TOTP_SECRET}`,
        `-input_file_path=${filePath}`,
        `-output_dir_path=${outDir}`,
      ],
      {
        cwd: CODE_SIGN_TOOL_PATH,
        env: process.env,
        stdio: 'inherit',
      }
    );
    const signed = path.join(outDir, path.basename(filePath));
    if (!fs.existsSync(signed)) {
      throw new Error(`CodeSignTool did not produce ${signed}`);
    }
    fs.copyFileSync(signed, filePath);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
};
