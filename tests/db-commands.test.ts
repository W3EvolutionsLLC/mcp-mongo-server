/**
 * Unit tests for db-commands.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { MongoClient, Db } from 'mongodb';
import { 
  connectToMongoDB, 
  disconnectFromMongoDB, 
  isMongoConnected,
  executeCommand,
  readFileChunk
} from '../src/db-commands.js';

// Mock MongoDB client
vi.mock('mongodb', () => {
  const mockCollection = {
    find: vi.fn().mockReturnThis(),
    findOne: vi.fn().mockResolvedValue({}),
    toArray: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockReturnThis(),
    indexes: vi.fn().mockResolvedValue([]),
    collectionName: 'test_collection'
  };
  
  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCollection),
    command: vi.fn().mockResolvedValue({})
  };
  
  const mockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockReturnValue(mockDb)
  };
  
  return {
    MongoClient: vi.fn().mockImplementation(() => mockClient),
    ServerApiVersion: { v1: '1' }
  };
});

// Mock fs module to avoid actual file operations
vi.mock('fs/promises', () => {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1000 }),
    open: vi.fn().mockResolvedValue({
      read: vi.fn().mockResolvedValue({ bytesRead: 100 }),
      close: vi.fn().mockResolvedValue(undefined)
    })
  };
});

describe('MongoDB Connection Functions', () => {
  it('should connect to MongoDB', async () => {
    const result = await connectToMongoDB('mongodb://localhost:27017');
    expect(result).toBe(true);
    expect(MongoClient).toHaveBeenCalledWith('mongodb://localhost:27017', expect.any(Object));
  });
  
  it('should disconnect from MongoDB', async () => {
    // Connect first
    await connectToMongoDB('mongodb://localhost:27017');
    
    // Then disconnect
    const result = await disconnectFromMongoDB();
    expect(result).toBe(true);
  });
  
  it('should return connection status', () => {
    // After connecting
    connectToMongoDB('mongodb://localhost:27017');
    expect(isMongoConnected()).toBe(true);
    
    // After disconnecting
    disconnectFromMongoDB();
    expect(isMongoConnected()).toBe(false);
  });
});

describe('Command Execution', () => {
  let mockDb: Db;
  
  beforeEach(() => {
    mockDb = {
      command: vi.fn().mockResolvedValue({ result: 'success' }),
      collection: vi.fn()
    } as unknown as Db;
  });
  
  it('should execute a valid command', async () => {
    const result = await executeCommand(mockDb, 'dbStats', {});
    expect(result).toEqual({ result: 'success' });
    expect(mockDb.command).toHaveBeenCalledWith({ dbStats: 1 });
  });
  
  it('should handle collStats command', async () => {
    const result = await executeCommand(mockDb, 'collStats', { collection: 'test_collection' });
    expect(result).toEqual({ result: 'success' });
    expect(mockDb.command).toHaveBeenCalledWith({ collStats: 'test_collection' });
  });
  
  it('should reject disallowed commands', async () => {
    await expect(executeCommand(mockDb, 'invalidCommand', {}))
      .rejects.toHaveProperty('code', 'COMMAND_NOT_ALLOWED');
  });
  
  it('should detect command injection attempts', async () => {
    await expect(executeCommand(mockDb, 'dbStats', { dropDatabase: 1 }))
      .rejects.toHaveProperty('code', 'INVALID_COMMAND_STRUCTURE');
  });
});

describe('File Operations', () => {
  it('should read file chunks safely', async () => {
    const result = await readFileChunk('/path/to/file.txt', 0, 1000);
    
    // Check that path is sanitized (only filename used)
    expect(fs.open).toHaveBeenCalledWith(
      expect.stringContaining(path.join(os.tmpdir(), 'file.txt')), 
      'r'
    );
    
    expect(result).toMatchObject({
      offset: 0,
      length: 100,
      hasMore: true
    });
  });
});
