import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { webcrypto, randomBytes } from 'node:crypto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
x509.cryptoProvider.set(webcrypto as any)

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const

export interface LeafCert {
  certPem: string
  privateKeyPem: string
}

function pemEncode(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64')
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

function pemDecode(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64')
}

const MAX_CACHED_CERTS = 200

export class CertCache {
  private readonly cache = new Map<string, LeafCert>()
  private readonly caKeys: { certPem: string; privateKeyPem: string }

  constructor(caKeys: { certPem: string; privateKeyPem: string }) {
    this.caKeys = caKeys
  }

  async get(hostname: string): Promise<LeafCert> {
    const cached = this.cache.get(hostname)
    if (cached) {
      // Move to end for LRU ordering
      this.cache.delete(hostname)
      this.cache.set(hostname, cached)
      return cached
    }
    const leaf = await this.generate(hostname)
    this.cache.set(hostname, leaf)
    // Evict oldest entry if over cap
    if (this.cache.size > MAX_CACHED_CERTS) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return leaf
  }

  private async generate(hostname: string): Promise<LeafCert> {
    const caCert = new x509.X509Certificate(this.caKeys.certPem)
    const caPrivateKey = await webcrypto.subtle.importKey(
      'pkcs8',
      pemDecode(this.caKeys.privateKeyPem),
      KEY_ALG,
      false,
      ['sign'],
    )

    const leafKeys = await webcrypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify'])
    const serialNum = BigInt(Date.now()).toString(16).padStart(12, '0') + randomBytes(4).toString('hex')

    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serialNum,
      issuer: caCert.subject,
      subject: `CN=${hostname}`,
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: SIGN_ALG,
      publicKey: leafKeys.publicKey,
      signingKey: caPrivateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature),
        new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
        new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }]),
        await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
      ],
    })

    const certPem = cert.toString('pem')
    const keyDer = await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey)
    const privateKeyPem = pemEncode('PRIVATE KEY', keyDer)

    return { certPem, privateKeyPem }
  }
}
