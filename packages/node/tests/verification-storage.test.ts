import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResponseAuthStorage, type StoredResponseAuth } from '../src/verification/storage.js';

describe('ResponseAuthStorage', () => {
  let directory: string;
  let databasePath: string;
  let storage: ResponseAuthStorage;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'antseed-response-auth-storage-'));
    databasePath = join(directory, 'verification.db');
    storage = new ResponseAuthStorage(databasePath);
  });

  afterEach(() => {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stores and retrieves a response auth', () => {
    const record: StoredResponseAuth = {
      version: 1,
      requestId: 'request-1',
      channelId: 'channel-1',
      buyerPeerId: 'buyer',
      sellerPeerId: 'seller',
      advertisedService: 'gpt-test',
      provider: 'test',
      statusCode: 200,
      requestHash: '0xrequest',
      responseHash: '0xresponse',
      responseStartedAt: 100,
      responseCompletedAt: 200,
      signature: '0xsignature',
      receivedAt: 300,
      verified: true,
      verificationError: null,
    };
    storage.insertResponseAuth(record);
    expect(storage.getResponseAuth(record.requestId)).toEqual(record);
  });

  it('creates only response-auth and migration tables', () => {
    const database = new Database(databasePath, { readonly: true });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => (row as { name: string }).name);
    database.close();
    expect(tables).toEqual(['response_auths', 'schema_version']);
  });
});
