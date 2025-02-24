#!/usr/bin/env node

/**
 * This is an MCP server that implements a MongoDB interface.
 * It demonstrates core MCP concepts by allowing:
 * - Listing collections as resources
 * - Reading collection schemas and contents
 * - Executing MongoDB queries via tools
 * - Providing collection summaries via prompts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MongoClient, ServerApiVersion } from "mongodb";
import { MongoCollection } from './types.js';
import { 
  commandToolSchema, 
  executeCommand, 
  readCommandResultSchema, 
  readFileChunk,
  connectToolSchema,
  disconnectToolSchema,
  connectToMongoDB,
  disconnectFromMongoDB,
  getMongoClient,
  getMongoDb,
  isMongoConnected
} from './db-commands.js';

/**
 * MongoDB connection client and database reference
 * @deprecated Use the functions from db-commands.js instead
 */
let client: MongoClient | null = null;
let db: any = null;

// Helper function to ensure backward compatibility
function updateLegacyClientReferences() {
  client = getMongoClient();
  db = getMongoDb();
}

/**
 * Create an MCP server with capabilities for resources (to list/read collections),
 * tools (to query data), and prompts (to analyze collections).
 */
const server = new Server(
  {
    name: "mongodb",
    version: "0.2.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {},
    },
  }
);

/**
 * Initialize MongoDB connection (deprecated, use db-commands.js functions instead)
 */
async function connectToMongoDBLegacy(url: string) {
  const connected = await connectToMongoDB(url);
  updateLegacyClientReferences();
  return connected;
}

/**
 * Handler for listing available collections as resources.
 * Each collection is exposed as a resource with:
 * - A mongodb:// URI scheme
 * - JSON MIME type
 * - Collection name and description
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Check if MongoDB is connected
  if (!client || !db) {
    return {
      resources: [],
      error: "Not connected to MongoDB. Please use the 'connect' tool first."
    };
  }
  
  try {
    const collections = await db.listCollections().toArray();
    return {
      resources: collections.map((collection: MongoCollection) => ({
        uri: `mongodb:///${collection.name}`,
        mimeType: "application/json",
        name: collection.name,
        description: `MongoDB collection: ${collection.name}`,
      })),
    };
  } catch (error) {
    return {
      resources: [],
      error: `Failed to list collections: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
});

/**
 * Handler for reading a collection's schema or contents.
 * Takes a mongodb:// URI and returns the collection info as JSON.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  // Check if MongoDB is connected
  if (!client || !db) {
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: "Not connected to MongoDB. Please use the 'connect' tool first." }, null, 2)
      }]
    };
  }

  const url = new URL(request.params.uri);
  const collectionName = url.pathname.replace(/^\//, "");

  try {
    const collection = db.collection(collectionName);
    const sample = await collection.findOne({});
    const indexes = await collection.indexes();

    // Infer schema from sample document
    const schema = sample ? {
      type: "collection",
      name: collectionName,
      fields: Object.entries(sample).map(([key, value]) => ({
        name: key,
        type: typeof value,
      })),
      indexes: indexes.map((idx: any) => ({
        name: idx.name,
        keys: idx.key,
      })),
    } : {
      type: "collection",
      name: collectionName,
      fields: [],
      indexes: [],
    };

    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify(schema, null, 2)
      }]
    };
  } catch (error) {
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: "application/json",
        text: JSON.stringify({ 
          error: `Failed to read collection ${collectionName}: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }, null, 2)
      }]
    };
  }
});

/**
 * Handler that lists available tools.
 * Exposes MongoDB query tools for interacting with collections.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Execute a MongoDB query",
        inputSchema: {
          type: "object",
          properties: {
            collection: {
              type: "string",
              description: "Name of the collection to query"
            },
            filter: {
              type: "object",
              description: "MongoDB query filter"
            },
            projection: {
              type: "object",
              description: "Fields to include/exclude"
            },
            limit: {
              type: "number",
              description: "Maximum number of documents to return"
            }
          },
          required: ["collection"]
        }
      },
      {
        name: "aggregate",
        description: "Execute a MongoDB aggregation pipeline",
        inputSchema: {
          type: "object",
          properties: {
            collection: {
              type: "string",
              description: "Name of the collection to aggregate"
            },
            pipeline: {
              type: "array",
              description: "Aggregation pipeline stages"
            }
          },
          required: ["collection", "pipeline"]
        }
      },
      connectToolSchema,
      disconnectToolSchema,
      commandToolSchema,
      readCommandResultSchema
    ]
  };
});

/**
 * Handler for MongoDB tools.
 * Executes queries and returns results.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // Check if MongoDB is connected for tools that require it
  if (!client && ['query', 'aggregate', 'run_command', 'read_command_result'].includes(request.params.name)) {
    return {
      content: [{
        type: "text",
        text: "Error: Not connected to MongoDB. Please use the 'connect' tool first."
      }]
    };
  }

  switch (request.params.name) {
    case "query": {
      const collection = db.collection(request.params.arguments?.collection);
      const { filter, projection, limit } = request.params.arguments || {};

      // Validate collection name to prevent access to system collections
      if (collection.collectionName.startsWith('system.')) {
        return {
          content: [{
            type: "text",
            text: "Error: Access to system collections is not allowed"
          }]
        };
      }

      // Validate and parse filter
      let queryFilter = {};
      if (filter) {
        if (typeof filter === 'string') {
          try {
            queryFilter = JSON.parse(filter);
          } catch (e) {
            return {
              content: [{
                type: "text",
                text: "Error: Invalid filter format: must be a valid JSON object"
              }]
            };
          }
        } else if (typeof filter === 'object' && filter !== null && !Array.isArray(filter)) {
          queryFilter = filter;
        } else {
          return {
            content: [{
              type: "text",
              text: "Error: Query filter must be a plain object or ObjectId"
            }]
          };
        }
      }

      // Execute the find operation with error handling
      try {
        const cursor = collection.find(queryFilter, {
          projection,
          limit: limit || 100
        });
        const results = await cursor.toArray();

        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error: Failed to query collection ${collection.collectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }

    case "aggregate": {
      const collection = db.collection(request.params.arguments?.collection);
      const { pipeline } = request.params.arguments || {};
      if (!Array.isArray(pipeline)) {
        return {
          content: [{
            type: "text",
            text: "Error: Pipeline must be an array"
          }]
        };
      }

      // Validate collection name to prevent access to system collections
      if (collection.collectionName.startsWith('system.')) {
        return {
          content: [{
            type: "text",
            text: "Error: Access to system collections is not allowed"
          }]
        };
      }

      // Execute the aggregation operation with error handling
      try {
        const results = await collection.aggregate(pipeline).toArray();

        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error: Failed to aggregate collection ${collection.collectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }

    case "run_command": {
      const { command, options = {} } = (request.params.arguments || {}) as {command: string, options: Record<string, any>}; 
      if (!command || typeof command !== 'string') {
        return {
          content: [{
            type: "text",
            text: "Error: Command name is required"
          }]
        };
      }
      
      console.error('run_command called with:', { command, options });
      
      // Special case for collStats - bypass executeCommand and use direct aggregation
      if (command === 'collStats') {
        try {
          const collName = options?.collection || options?.collStats || '';
          if (!collName) {
            return {
              content: [{
                type: "text",
                text: "Error: Collection name is required for collStats"
              }]
            };
          }

          // Check if we should write to a file
          if (options.outputToFile) {
            console.error(`Using file output for collStats on collection: ${collName}`);
            // Execute command with special option to write large results to file
            const result = await executeCommand(db, command, options);
            return {
              content: [{
                type: "text",
                text: JSON.stringify(result, null, 2)
              }]
            };
          }
          
          // Default behavior using aggregation with $collStats
          const collection = db.collection(collName);
          console.error(`Getting stats for collection: ${collName} using aggregation`);
          
          // Try to execute with regular command first (may truncate if too large)
          const result = await executeCommand(db, command, options);
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2)
            }]
          };
        } catch (error) {
          console.error('Error handling collStats command:', error);
          return {
            content: [{
              type: "text",
              text: `Error: collStats command failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`
            }]
          };
        }
      }
      
      try {
        // Execute other commands through the regular flow
        const result = await executeCommand(db, command, options);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error: Command execution failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`
          }]
        };
      }
    }
    
    case "read_command_result": {
      const { filePath, offset = 0, length = 50000 } = (request.params.arguments || {}) as {filePath: string, offset?: number, length?: number};
      
      if (!filePath || typeof filePath !== 'string') {
        return {
          content: [{
            type: "text",
            text: "Error: File path is required"
          }]
        };
      }
      
      try {
        const result = await readFileChunk(filePath, offset, length);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error: Failed to read command result: ${error instanceof Error ? error.message : JSON.stringify(error)}`
          }]
        };
      }
    }
      
    case "connect": {
      try {
        const { host, port, database, user, password } = request.params.arguments || {};
        
        // Construct the connection URL
        let url = "mongodb://";
        
        // Add credentials if provided
        if (user && password) {
          url += `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
        }
        
        // Add host and port
        url += `${host || 'localhost'}:${port || 27017}`;
        
        // Add database if provided
        if (database) {
          url += `/${database}`;
        }
        
        // Connect to MongoDB
        const connected = await connectToMongoDB(url);
        updateLegacyClientReferences();
        
        if (connected) {
          return {
            content: [{
              type: "text",
              text: "Successfully connected to MongoDB"
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: "Failed to connect to MongoDB"
            }]
          };
        }
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error connecting to MongoDB: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
    
    case "disconnect": {
      try {
        const disconnected = await disconnectFromMongoDB();
        updateLegacyClientReferences();
        
        if (disconnected) {
          return {
            content: [{
              type: "text",
              text: "Successfully disconnected from MongoDB"
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: "Not connected to MongoDB"
            }]
          };
        }
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error disconnecting from MongoDB: ${error instanceof Error ? error.message : 'Unknown error'}`
          }]
        };
      }
    }
        
    default:
      return {
        content: [{
          type: "text",
          text: "Unknown tool"
        }]
      };
  }
});

/**
 * Handler that lists available prompts.
 * Exposes prompts for analyzing collections.
 */
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "analyze_collection",
        description: "Analyze a MongoDB collection structure and contents",
        arguments: [
          {
            name: "collection",
            description: "Name of the collection to analyze",
            required: true
          }
        ]
      }
    ]
  };
});

/**
 * Handler for collection analysis prompt.
 * Returns a prompt that requests analysis of a collection's structure and data.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "analyze_collection") {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Unknown prompt. The only available prompt is 'analyze_collection'."
          }
        }
      ]
    };
  }

  const collectionName = request.params.arguments?.collection;
  if (!collectionName) {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Collection name is required for the 'analyze_collection' prompt."
          }
        }
      ]
    };
  }
  
  // Check if MongoDB is connected
  if (!client || !db) {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Not connected to MongoDB. Please use the 'connect' tool first."
          }
        }
      ]
    };
  }

  try {
    const collection = db.collection(collectionName);

    // Validate collection name to prevent access to system collections
    if (collection.collectionName.startsWith('system.')) {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Access to system collections is not allowed."
            }
          }
        ]
      };
    }

    const schema = await collection.findOne({});

    // Get basic collection stats - just count in API v1
    const stats = await collection.aggregate([
      {
        $collStats: {
          count: {}
        }
      }
    ]).toArray();

    // Also get a sample of documents to show data distribution
    const sampleDocs = await collection.find({})
      .limit(5)
      .toArray();

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please analyze the following MongoDB collection:
Collection: ${collectionName}

Schema:
${JSON.stringify(schema, null, 2)}

Stats:
Document count: ${stats[0]?.count || 'unknown'}

Sample documents:
${JSON.stringify(sampleDocs, null, 2)}`
          }
        },
        {
          role: "user",
          content: {
            type: "text",
            text: "Provide insights about the collection's structure, data types, and basic statistics."
          }
        }
      ]
    };
  } catch (error) {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Failed to analyze collection ${collectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`
          }
        }
      ]
    };
  }
});

/**
 * Handler for listing templates.
 * Exposes templates for constructing MongoDB queries.
 */
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return {
    resourceTemplates: [
      {
        name: "mongodb_query",
        description: "Template for constructing MongoDB queries",
        uriTemplate: "mongodb:///{collection}",
        text: `To query MongoDB collections, you can use these operators:

Filter operators:
- $eq: Matches values equal to a specified value
- $gt/$gte: Matches values greater than (or equal to) a specified value
- $lt/$lte: Matches values less than (or equal to) a specified value
- $in: Matches any of the values in an array
- $nin: Matches none of the values in an array
- $ne: Matches values not equal to a specified value
- $exists: Matches documents that have the specified field

Example queries:
1. Find documents where age > 21:
{ "age": { "$gt": 21 } }

2. Find documents with specific status:
{ "status": { "$in": ["active", "pending"] } }

3. Find documents with existing email:
{ "email": { "$exists": true } }

Use these patterns to construct MongoDB queries.`
      }
    ]
  };
});

/**
 * Start the server using stdio transport and initialize MongoDB connection.
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Please provide a MongoDB connection URL as a command-line argument");
    process.exit(1);
  }

  const connected = await connectToMongoDBLegacy(args[0]);
  if (!connected) {
    console.error("Failed to connect to MongoDB");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Handle cleanup
process.on("SIGINT", async () => {
  await disconnectFromMongoDB();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await disconnectFromMongoDB();
  process.exit(0);
});

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});