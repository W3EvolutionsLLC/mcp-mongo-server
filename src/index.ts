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

/**
 * MongoDB connection client and database reference
 */
let client: MongoClient | null = null;
let db: any = null;

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
 * Initialize MongoDB connection
 */
async function connectToMongoDB(url: string) {
  try {
    client = new MongoClient(url, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    await client.connect();
    db = client.db();
    return true;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    return false;
  }
}

/**
 * Handler for listing available collections as resources.
 * Each collection is exposed as a resource with:
 * - A mongodb:// URI scheme
 * - JSON MIME type
 * - Collection name and description
 */
server.setRequestHandler(ListResourcesRequestSchema, async () => {
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
    if (error instanceof Error) {
      throw new Error(`Failed to list collections: ${error.message}`);
    }
    throw new Error('Failed to list collections: Unknown error');
  }
});

/**
 * Handler for reading a collection's schema or contents.
 * Takes a mongodb:// URI and returns the collection info as JSON.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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
    if (error instanceof Error) {
      throw new Error(`Failed to read collection ${collectionName}: ${error.message}`);
    }
    throw new Error(`Failed to read collection ${collectionName}: Unknown error`);
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
      }
    ]
  };
});

/**
 * Handler for MongoDB tools.
 * Executes queries and returns results.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const collection = db.collection(request.params.arguments?.collection);

  switch (request.params.name) {
    case "query": {
      const { filter, projection, limit } = request.params.arguments || {};

      // Validate collection name to prevent access to system collections
      if (collection.collectionName.startsWith('system.')) {
        throw new Error('Access to system collections is not allowed');
      }

      // Validate and parse filter
      let queryFilter = {};
      if (filter) {
        if (typeof filter === 'string') {
          try {
            queryFilter = JSON.parse(filter);
          } catch (e) {
            throw new Error('Invalid filter format: must be a valid JSON object');
          }
        } else if (typeof filter === 'object' && filter !== null && !Array.isArray(filter)) {
          queryFilter = filter;
        } else {
          throw new Error('Query filter must be a plain object or ObjectId');
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
        if (error instanceof Error) {
          throw new Error(`Failed to query collection ${collection.collectionName}: ${error.message}`);
        }
        throw new Error(`Failed to query collection ${collection.collectionName}: Unknown error`);
      }
    }

    case "aggregate": {
      const { pipeline } = request.params.arguments || {};
      if (!Array.isArray(pipeline)) {
        throw new Error("Pipeline must be an array");
      }

      // Validate collection name to prevent access to system collections
      if (collection.collectionName.startsWith('system.')) {
        throw new Error('Access to system collections is not allowed');
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
        if (error instanceof Error) {
          throw new Error(`Failed to aggregate collection ${collection.collectionName}: ${error.message}`);
        }
        throw new Error(`Failed to aggregate collection ${collection.collectionName}: Unknown error`);
      }
    }

    default:
      throw new Error("Unknown tool");
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
    throw new Error("Unknown prompt");
  }

  const collectionName = request.params.arguments?.collection;
  if (!collectionName) {
    throw new Error("Collection name is required");
  }

  try {
    const collection = db.collection(collectionName);

    // Validate collection name to prevent access to system collections
    if (collection.collectionName.startsWith('system.')) {
      throw new Error('Access to system collections is not allowed');
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
    if (error instanceof Error) {
      throw new Error(`Failed to analyze collection ${collectionName}: ${error.message}`);
    } else {
      throw new Error(`Failed to analyze collection ${collectionName}: Unknown error`);
    }
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

  const connected = await connectToMongoDB(args[0]);
  if (!connected) {
    console.error("Failed to connect to MongoDB");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Handle cleanup
process.on("SIGINT", async () => {
  if (client) {
    await client.close();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (client) {
    await client.close();
  }
  process.exit(0);
});

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});