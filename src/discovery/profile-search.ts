import type { PeerProfile, ProfileCapability } from '../types/peer-profile.js';

export interface ProfileSearchQuery {
  capability?: ProfileCapability;
  tags?: string[];
  region?: string;
  text?: string;
}

export interface ProfileSearchResult {
  profile: PeerProfile;
  relevanceScore: number;
}

/**
 * In-memory search index for cached peer profiles.
 */
export class ProfileSearchIndex {
  private profiles: Map<string, PeerProfile> = new Map();

  addProfile(profile: PeerProfile): void {
    this.profiles.set(profile.peerId, profile);
  }

  removeProfile(peerId: string): void {
    this.profiles.delete(peerId);
  }

  getProfile(peerId: string): PeerProfile | null {
    return this.profiles.get(peerId) ?? null;
  }

  getAllProfiles(): PeerProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Search profiles with relevance scoring.
   */
  search(query: ProfileSearchQuery): ProfileSearchResult[] {
    const results: ProfileSearchResult[] = [];

    for (const profile of this.profiles.values()) {
      let score = 0;

      // Filter by capability (hard filter)
      if (query.capability) {
        if (!profile.capabilities.includes(query.capability)) continue;
        score += 10;
      }

      // Filter by region (boost score)
      if (query.region) {
        if (profile.region.toLowerCase() === query.region.toLowerCase()) {
          score += 5;
        }
      }

      // Tag matching (boost score)
      if (query.tags && query.tags.length > 0) {
        const profileTags = new Set(profile.tags.map(t => t.toLowerCase()));
        let tagMatches = 0;
        for (const tag of query.tags) {
          if (profileTags.has(tag.toLowerCase())) {
            tagMatches++;
          }
        }
        if (tagMatches > 0) {
          score += tagMatches * 3;
        }
      }

      // Text search in name and description
      if (query.text) {
        const text = query.text.toLowerCase();
        if (profile.displayName.toLowerCase().includes(text)) {
          score += 8;
        }
        if (profile.description.toLowerCase().includes(text)) {
          score += 4;
        }
        if (profile.tags.some(t => t.toLowerCase().includes(text))) {
          score += 2;
        }
      }

      if (score > 0) {
        results.push({ profile, relevanceScore: score });
      }
    }

    // Sort by relevance (descending)
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results;
  }

  get size(): number {
    return this.profiles.size;
  }
}
