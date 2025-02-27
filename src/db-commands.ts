/**
 * MongoDB database command handler with security controls
 */
import { Db, MongoClient, ServerApiVersion } from "mongodb";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { 
  ALLOWED_COMMANDS, 
  DANGEROUS_OPERATORS,
  MongoCommandError,
  MongoCommandErrorCode,
  AllowedCommand
} from "./db-command-types.js";

// Maximum size (in chars) for direct response before using temp file
const MAX_RESPONSE_SIZE = 100000;

// Default timeout for operations (in milliseconds)
const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * Creates a command error with the specified code and message
 */
function createCommandError(
  code: MongoCommandErrorCode, 
  message: string, 
  details?: unknown
): MongoCommandError {
  return { code, message, details };
}

/**
 * Execute a promise with a timeout
 * @param promise The promise to execute
 * @param timeoutMs Timeout in milliseconds
 * @param errorMessage Custom error message
 * @returns Promise result
 */
async function withTimeout<T>(
  promise: Promise<T>, 
  timeoutMs: number = DEFAULT_TIMEOUT, 
  errorMessage: string = "Operation timed out"
): Promise<T> {
  // Create a timeout promise that rejects after specified time
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      clearTimeout(timeoutId);
      reject(createCommandError(
        "TIMEOUT_ERROR",
        errorMessage,
        { timeoutMs }
      ));
    }, timeoutMs);
  });
  
  // Race the original promise against the timeout
  return Promise.race([promise, timeoutPromise]);
}

/**
 * Returns a configuration object for connecting to MongoDB.
 *
 * The configuration object includes the following properties:
 *
 * - `host`: The hostname or IP address of the MongoDB server.
 * - `port`: The port number that the MongoDB server is listening on.
 * - `database`: The name of the database to connect to.
 * - `user`: The username to use for authentication.
 * - `password`: The password to use for authentication.
 *
 * The values of these properties are determined by the following environment
 * variables:
 *
 * - `MONGO_HOST`
 * - `MONGO_PORT`
 * - `MONGO_DATABASE`
 * - `MONGO_USER`
 * - `MONGO_PASSWORD`
 *
 * If any of these environment variables are not set, the following default
 * values are used:
 *
 * - `host`: "localhost"
 * - `port`: 27017
 * - `database`: "test"
 */
function getMongoConfig(): {
  host: string;
  port: number;
  database: string;
  user: string | undefined;
  password: string | undefined;
} {
  return {
    host: process.env.MONGO_HOST || "localhost",
    port: parseInt(process.env.MONGO_PORT || "27017", 10),
    database: process.env.MONGO_DATABASE || "test",
    user: process.env.MONGO_USER,
    password: process.env.MONGO_PASSWORD,
  };
}

// Reference variables for MongoDB client and database
let mongoClient: MongoClient | null = null;
let mongoDb: Db | null = null;

/**
 * Initialize MongoDB connection
 * @param url MongoDB connection URL
 * @returns True if connected successfully, false otherwise
 */
export async function connectToMongoDB(url: string): Promise<boolean> {
  try {
    // Close existing connection if any
    if (mongoClient) {
      await mongoClient.close();
      mongoClient = null;
      mongoDb = null;
    }
    
    // Create MongoDB client with serverApi configuration
    mongoClient = new MongoClient(url, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db();
    return true;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    return false;
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectFromMongoDB(): Promise<boolean> {
  try {
    if (mongoClient) {
      await mongoClient.close();
      mongoClient = null;
      mongoDb = null;
      return true;
    }
    return false;
  } catch (error) {
    console.error("Failed to disconnect from MongoDB:", error);
    return false;
  }
}

/**
 * Get MongoDB client instance
 */
export function getMongoClient(): MongoClient | null {
  return mongoClient;
}

/**
 * Get MongoDB database instance
 */
export function getMongoDb(): Db | null {
  return mongoDb;
}

/**
 * Checks if MongoDB is connected
 */
export function isMongoConnected(): boolean {
  return !!mongoClient && !!mongoDb;
}

/**
 * Sanitizes a file path to prevent path traversal attacks
 * @param filePath The path to sanitize
 * @returns Sanitized file path
 */
function sanitizeFilePath(filePath: string): string {
  // Normalize the path to resolve '..' and '.' segments
  const normalizedPath = path.normalize(filePath);
  
  // Get the basename to strip any directory components
  const baseName = path.basename(normalizedPath);
  
  // Ensure the file is in the temp directory
  return path.join(os.tmpdir(), baseName);
}

/**
 * Writes large command results to a temporary file
 * @param data Data to write to file
 * @returns Object with file path and information
 */
async function writeResultToTempFile(data: unknown): Promise<{
  filePath: string;
  size: number;
  timestamp: string;
  notice: string;
}> {
  try {
    // Create a unique temporary file name
    const tempDir = os.tmpdir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `mongodb-result-${timestamp}.json`;
    const filePath = path.join(tempDir, fileName);
    
    // Write the data as formatted JSON
    const jsonData = JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, jsonData, 'utf8');
    
    // Get file stats
    const stats = await fs.stat(filePath);
    
    return {
      filePath,
      size: stats.size,
      timestamp,
      notice: "Result exceeded size limit and was written to a temporary file."
    };
  } catch (error) {
    if (error instanceof Error) {
      throw createCommandError(
        "FILE_OPERATION_ERROR",
        `Failed to write results to temp file: ${error.message}`,
        error
      );
    }
    throw createCommandError(
      "FILE_OPERATION_ERROR",
      "Failed to write results to temp file: Unknown error",
      error
    );
  }
}

/**
 * Reads a chunk of data from a file
 * @param filePath Path to the file
 * @param offset Start position to read from
 * @param length Number of bytes to read
 * @returns Object with chunk data and position information
 */
export async function readFileChunk(
  filePath: string,
  offset = 0,
  length = 50000
): Promise<{
  chunk: string;
  offset: number;
  length: number;
  totalSize: number;
  hasMore: boolean;
}> {
  try {
    // Sanitize the file path to prevent path traversal
    const sanitizedPath = sanitizeFilePath(filePath);
    
    const handle = await fs.open(sanitizedPath, 'r');
    try {
      const stats = await fs.stat(filePath);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      
      return {
        chunk: buffer.subarray(0, bytesRead).toString('utf8'),
        offset,
        length: bytesRead,
        totalSize: stats.size,
        hasMore: offset + bytesRead < stats.size
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error) {
      throw createCommandError(
        "FILE_OPERATION_ERROR",
        `Failed to read from temp file: ${error.message}`,
        error
      );
    }
    throw createCommandError(
      "FILE_OPERATION_ERROR",
      "Failed to read from temp file: Unknown error",
      error
    );
  }
}

/**
 * Validates a MongoDB command request for security
 * @param command The command name to execute
 * @param options Additional command options
 * @throws MongoCommandError if the command is not allowed or contains dangerous operations
 */
export function validateCommand(command: string, options: Record<string, unknown> = {}): void {
  // Check if command is in allowlist
  if (!ALLOWED_COMMANDS.includes(command as AllowedCommand)) {
    throw createCommandError(
      "COMMAND_NOT_ALLOWED",
      `Command '${command}' is not allowed. Allowed commands: ${ALLOWED_COMMANDS.join(', ')}`
    );
  }
  
  // Create the command object to validate its structure
  const commandObj = command === 'collStats' 
    ? { [command]: options?.collection || '', ...options }
    : { [command]: 1, ...options };
  
  // Prevent command injection 
  const commandKeys = Object.keys(commandObj);
  for (const key of commandKeys) {
    if (key !== command && ALLOWED_COMMANDS.includes(key as AllowedCommand)) {
      throw createCommandError(
        "INVALID_COMMAND_STRUCTURE",
        `Invalid command structure: Contains another command key '${key}'`
      );
    }
  }
  
  // Check for dangerous operators in the entire command structure
  const flattenedObj = JSON.stringify(commandObj);
  for (const dangerous of DANGEROUS_OPERATORS) {
    if (flattenedObj.includes(`"${dangerous}":`)) {
      throw createCommandError(
        "DANGEROUS_OPERATION",
        `Command contains potentially dangerous operation: ${dangerous}`
      );
    }
  }
}

/**
 * Executes a validated MongoDB database command
 * @param db MongoDB database instance
 * @param command The command to execute
 * @param options Additional command options
 * @returns The command result or file info if using outputToFile
 * @throws MongoCommandError if validation or execution fails
 */
export async function executeCommand(
  db: Db, 
  command: string, 
  options: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    // Extract options that control response handling
    const outputToFile = !!options.outputToFile;
    const forceOutput = !!options.forceOutput;
    const timeout = typeof options.timeout === 'number' ? options.timeout : DEFAULT_TIMEOUT;
    
    // Remove our custom options before passing to MongoDB
    const cleanOptions = { ...options };
    delete cleanOptions.outputToFile;
    delete cleanOptions.forceOutput;
    delete cleanOptions.timeout;
    
    // Perform security validation
    validateCommand(command, cleanOptions);

    console.error('executeCommand -> ', command, cleanOptions);
    
    // Build the command object with the command name as a key
    let commandObj;
    
    if (command === 'collStats') {
      // For collStats, the value should be the collection name
      const collName = cleanOptions?.collection || cleanOptions?.collStats;
      commandObj = { [command]: collName, ...cleanOptions };
      // Remove duplicate options
      if ('collection' in commandObj) {
        delete commandObj.collection;
      }
      if ('collStats' in commandObj) {
        delete commandObj.collStats;
      }
    } else if (command === 'dbStats') {
      // For dbStats, typically no collection is needed
      commandObj = { [command]: 1, ...cleanOptions };
    } else {
      // Default case for other commands
      commandObj = { [command]: cleanOptions?.collection || 1, ...cleanOptions };
    }
    
    // Execute the validated command with timeout
    const result = await withTimeout(
      db.command(commandObj),
      timeout,
      `Command '${command}' timed out after ${timeout}ms`
    );
    
    // Calculate result size before serialization (for estimation)
    const resultJson = JSON.stringify(result);
    const resultSize = resultJson.length;
    
    // If result exceeds size limit or output to file was requested
    if ((resultSize > MAX_RESPONSE_SIZE || outputToFile) && !forceOutput) {
      console.error(`Result size (${resultSize}) exceeds limit. Writing to file.`);
      return await writeResultToTempFile(result);
    }
    
    // Return the result directly if it's under the limit or forceOutput is true
    return result;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      // Pass through our custom errors
      throw error;
    }
    
    if (error instanceof Error) {
      throw createCommandError(
        "EXECUTION_ERROR",
        `Failed to execute command '${command}': ${error.message}`,
        error
      );
    }
    
    throw createCommandError(
      "EXECUTION_ERROR",
      `Failed to execute command '${command}': Unknown error`,
      error
    );
  }
}

/**
 * Tool schema for MongoDB commands
 */
export const commandToolSchema = {
  name: "run_command",
  description: "Execute specific MongoDB database commands (read-only)",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: `The command to execute (limited to: ${ALLOWED_COMMANDS.join(', ')})`
      },
      options: {
        type: "object",
        description: "Command options with additional parameters: outputToFile (boolean) to write large results to a temp file, forceOutput (boolean) to force direct output, timeout (number) in ms for operation timeout"
      }
    },
    required: ["command"]
  }
};

/**
 * Tool schema for reading command results from a temp file
 */
export const readCommandResultSchema = {
  name: "read_command_result",
  description: "Read chunks of a large MongoDB command result from a temporary file",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the temporary file containing command results"
      },
      offset: {
        type: "number",
        description: "Starting position to read from (in bytes)"
      },
      length: {
        type: "number",
        description: "Number of bytes to read"
      }
    },
    required: ["filePath"]
  }
};

/**
 * Tool schema for connecting to MongoDB
 */
export const connectToolSchema = {
  name: "connect",
  description: "Connect to the MongoDB server",
  inputSchema: {
    type: "object",
    properties: {
      host: {
        type: "string",
        description: "MongoDB server hostname (defaults to env var or localhost)"
      },
      port: {
        type: "integer",
        description: "MongoDB server port (defaults to env var or 27017)"
      },
      database: {
        type: "string",
        description: "MongoDB database name (defaults to env var)"
      },
      user: {
        type: "string",
        description: "MongoDB username (defaults to env var)"
      },
      password: {
        type: "string",
        description: "MongoDB password (defaults to env var)"
      }
    },
    required: []
  }
};

/**
 * Tool schema for disconnecting from MongoDB
 */
export const disconnectToolSchema = {
  name: "disconnect",
  description: "Disconnect from the MongoDB server",
  inputSchema: {
    type: "object",
    properties: {},
    required: []
  }
};
