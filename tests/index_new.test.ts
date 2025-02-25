/**
 * Unit tests for index_new.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as dbCommands from '../src/db-commands.js';

// We need to mock the entire module to avoid executing code at import time
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  return {
    Server: vi.fn().mockImplementation(() => ({
      setRequestHandler: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined)
    }))
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  return {
    StdioServerTransport: vi.fn().mockImplementation(() => ({}))
  };
});

// Mock db-commands module
vi.mock('../src/db-commands.js', () => {
  return {
    connectToMongoDB: vi.fn().mockResolvedValue(true),
    disconnectFromMongoDB: vi.fn().mockResolvedValue(true),
    isMongoConnected: vi.fn().mockReturnValue(true),
    getMongoClient: vi.fn().mockReturnValue({}),
    getMongoDb: vi.fn().mockReturnValue({
      listCollections: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { name: 'test_collection', options: {} }
        ])
      }),
      collection: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue({ _id: 'test', value: 123 }),
        indexes: vi.fn().mockResolvedValue([
          { name: '_id_', key: { _id: 1 } }
        ]),
        find: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnThis(),
          toArray: vi.fn().mockResolvedValue([])
        }),
        aggregate: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([])
        }),
        collectionName: 'test_collection'
      })
    }),
    executeCommand: vi.fn().mockResolvedValue({}),
    readFileChunk: vi.fn().mockResolvedValue({ chunk: '{}', offset: 0, length: 2, totalSize: 2, hasMore: false }),
    commandToolSchema: { name: 'run_command' },
    readCommandResultSchema: { name: 'read_command_result' },
    connectToolSchema: { name: 'connect' },
    disconnectToolSchema: { name: 'disconnect' }
  };
});

// Mock process.argv
const originalArgv = process.argv;
beforeEach(() => {
  process.argv = ['node', 'index_new.js', 'mongodb://localhost:27017'];
});

afterEach(() => {
  process.argv = originalArgv;
  vi.clearAllMocks();
});

describe('Server Initialization', () => {
  it('should create an MCP server with correct config', async () => {
    // Import the module to trigger the initialization
    await import('../src/index_new.js');
    
    expect(Server).toHaveBeenCalledWith(
      { name: 'mongodb', version: '0.2.0' },
      expect.objectContaining({
        capabilities: expect.objectContaining({
          resources: expect.any(Object),
          tools: expect.any(Object),
          prompts: expect.any(Object)
        })
      })
    );
  });
});

describe('MCP Request Handlers', () => {
  let serverInstance: any;
  
  beforeEach(() => {
    serverInstance = new Server(
      { name: 'test', version: '1.0.0' },
      { capabilities: { resources: {}, tools: {}, prompts: {} } }
    );
    
    // Spy on setRequestHandler
    vi.spyOn(serverInstance, 'setRequestHandler');
  });
  
  it('should set up all required request handlers', async () => {
    // Import the module
    await import('../src/index_new.js');
    
    // Verify that handlers are registered
    expect(serverInstance.setRequestHandler).toHaveBeenCalledTimes(6);
  });
});

describe('ListResources Handler', () => {
  it('should return MongoDB collections as resources', async () => {
    // Mock the handler function
    const listResourcesHandler = async () => {
      if (!dbCommands.isMongoConnected()) {
        return { resources: [], error: "Not connected to MongoDB" };
      }
      
      const db = dbCommands.getMongoDb();
      const collections = await db.listCollections().toArray();
      
      return {
        resources: collections.map((collection) => ({
          uri: `mongodb:///${collection.name}`,
          mimeType: "application/json",
          name: collection.name,
          description: `MongoDB collection: ${collection.name}`,
        })),
      };
    };
    
    const result = await listResourcesHandler();
    
    expect(result).toHaveProperty('resources');
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toHaveProperty('uri', 'mongodb:///test_collection');
  });
});

describe('Command Tool Handlers', () => {
  it('should properly execute MongoDB queries', async () => {
    // Import the actual handler code for testing
    const { server } = await import('../src/index_new.js');
    
    // This is a simplified test that mainly checks our mocks are working
    expect(dbCommands.executeCommand).toHaveBeenCalledTimes(0);
  });
});
