import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PeerId } from '../types/peer.js';
import type { PeerProfile, ProfileCapability } from '../types/peer-profile.js';
import type { Identity } from '../p2p/identity.js';
import { signData } from '../p2p/identity.js';
import { bytesToHex } from '../utils/hex.js';

export interface ProfileManagerConfig {
  configDir: string;
  identity?: Identity;
}

export class ProfileManager {
  private readonly configDir: string;
  private readonly identity: Identity | undefined;
  private profile: PeerProfile | null = null;

  constructor(config: ProfileManagerConfig) {
    this.configDir = config.configDir;
    this.identity = config.identity;
  }

  /**
   * Create a new peer profile.
   */
  createProfile(data: {
    displayName: string;
    description: string;
    tags?: string[];
    capabilities?: ProfileCapability[];
    region?: string;
    languages?: string[];
    website?: string;
    avatar?: string;
  }): PeerProfile {
    if (!this.identity) {
      throw new Error('Identity required to create profile');
    }

    const now = Date.now();
    this.profile = {
      peerId: this.identity.peerId as PeerId,
      displayName: data.displayName,
      description: data.description,
      tags: data.tags ?? [],
      capabilities: data.capabilities ?? ['inference'],
      region: data.region ?? 'unknown',
      languages: data.languages ?? ['en'],
      website: data.website,
      avatar: data.avatar,
      createdAt: now,
      updatedAt: now,
    };

    return this.profile;
  }

  /**
   * Update an existing profile.
   */
  updateProfile(updates: Partial<Omit<PeerProfile, 'peerId' | 'createdAt'>>): PeerProfile {
    if (!this.profile) {
      throw new Error('No profile exists — call createProfile first');
    }

    this.profile = {
      ...this.profile,
      ...updates,
      peerId: this.profile.peerId, // immutable
      createdAt: this.profile.createdAt, // immutable
      updatedAt: Date.now(),
    };

    return this.profile;
  }

  /**
   * Get the current profile.
   */
  getProfile(): PeerProfile | null {
    return this.profile;
  }

  /**
   * Get SHA-256 hash of the profile for metadata announcements.
   */
  getProfileHash(): string {
    if (!this.profile) return '';
    const json = JSON.stringify(this.profile);
    return createHash('sha256').update(json).digest('hex');
  }

  /**
   * Sign the profile hash with the identity's private key.
   */
  async getProfileSignature(): Promise<string> {
    if (!this.identity || !this.profile) {
      throw new Error('Identity and profile required for signing');
    }
    const hash = this.getProfileHash();
    const hashBytes = new TextEncoder().encode(hash);
    const signature = await signData(this.identity.privateKey, hashBytes);
    return bytesToHex(signature);
  }

  /**
   * Save profile to disk.
   */
  async save(): Promise<void> {
    if (!this.profile) return;
    await mkdir(this.configDir, { recursive: true });
    const filePath = join(this.configDir, 'profile.json');
    await writeFile(filePath, JSON.stringify(this.profile, null, 2), 'utf-8');
  }

  /**
   * Load profile from disk.
   */
  async load(): Promise<void> {
    const filePath = join(this.configDir, 'profile.json');
    try {
      const raw = await readFile(filePath, 'utf-8');
      this.profile = JSON.parse(raw) as PeerProfile;
    } catch {
      // File doesn't exist — no profile yet
      this.profile = null;
    }
  }
}
