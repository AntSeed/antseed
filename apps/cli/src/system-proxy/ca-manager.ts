import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { webcrypto } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
x509.cryptoProvider.set(webcrypto as any)

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const

export interface CAKeys {
  certPem: string
  privateKeyPem: string
}

export interface CAInstallResult {
  target: 'system-keychain' | 'login-keychain' | 'windows-root' | 'linux-system'
  warning?: string
}

function pemEncode(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class CAManager {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'system-proxy')
  }

  private get certPath(): string { return join(this.dir, 'ca.crt') }
  private get keyPath(): string { return join(this.dir, 'ca.key') }

  get certFilePath(): string { return this.certPath }

  async exists(): Promise<boolean> {
    return existsSync(this.certPath) && existsSync(this.keyPath)
  }

  async load(): Promise<CAKeys> {
    const [certPem, privateKeyPem] = await Promise.all([
      readFile(this.certPath, 'utf8'),
      readFile(this.keyPath, 'utf8'),
    ])
    return { certPem, privateKeyPem }
  }

  async generate(): Promise<CAKeys> {
    await mkdir(this.dir, { recursive: true })

    const keyPair = await webcrypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify'])

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: 'CN=AntSeed Local CA, O=AntSeed',
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: SIGN_ALG,
      keys: keyPair,
      extensions: [
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
        await x509.SubjectKeyIdentifierExtension.create(keyPair.publicKey),
      ],
    })

    const certPem = cert.toString('pem')
    const keyDer = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey)
    const privateKeyPem = pemEncode('PRIVATE KEY', keyDer)

    await writeFile(this.certPath, certPem, 'utf8')
    await writeFile(this.keyPath, privateKeyPem, { encoding: 'utf8', mode: 0o600 })

    return { certPem, privateKeyPem }
  }

  async installToSystemKeychain(): Promise<CAInstallResult> {
    const platform = process.platform
    if (platform === 'darwin') {
      const systemCommand = `security add-trusted-cert -d -r trustRoot -p ssl -k ${shellQuote('/Library/Keychains/System.keychain')} ${shellQuote(this.certPath)}`
      try {
        execSync(systemCommand, { stdio: 'pipe' })
        return { target: 'system-keychain' }
      } catch (systemErr) {
        try {
          execSync(
            `osascript -e ${shellQuote(`do shell script ${JSON.stringify(systemCommand)} with administrator privileges`)}`,
            { stdio: 'pipe' },
          )
          return { target: 'system-keychain' }
        } catch (adminErr) {
          const keychainPath = join(homedir(), 'Library', 'Keychains', 'login.keychain-db')
          try {
            execSync(
              `security add-trusted-cert -d -r trustRoot -p ssl -k ${shellQuote(keychainPath)} ${shellQuote(this.certPath)}`,
              { stdio: 'pipe' },
            )
            return {
              target: 'login-keychain',
              warning: [
                'CA certificate was trusted in the login keychain only.',
                'Some GUI apps may require System keychain trust and a restart.',
                `System keychain install failed: ${errorMessage(adminErr)}`,
              ].join(' '),
            }
          } catch (loginErr) {
            throw new Error([
              `System keychain install failed: ${errorMessage(systemErr)}`,
              `Admin install failed: ${errorMessage(adminErr)}`,
              `Login keychain install failed: ${errorMessage(loginErr)}`,
            ].join(' '))
          }
        }
      }
    } else if (platform === 'win32') {
      execFileSync('certutil', ['-addstore', '-f', 'Root', this.certPath], { stdio: 'pipe' })
      return { target: 'windows-root' }
    } else {
      execFileSync('sudo', ['cp', this.certPath, '/usr/local/share/ca-certificates/antseed-ca.crt'], { stdio: 'pipe' })
      execFileSync('sudo', ['update-ca-certificates'], { stdio: 'pipe' })
      return { target: 'linux-system' }
    }
  }
}
