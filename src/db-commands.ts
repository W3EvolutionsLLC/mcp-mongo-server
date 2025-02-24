/**
 * MongoDB database command handler with security controls
 */
import { Db } from "mongodb";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { 
  ALLOWED_COMMANDS, 
  DANGEROUS_OPERATORS,
  MongoCommandError,
  MongoCommandErrorCode
} from "./db-command-types.js";

// Maximum size (in chars) for direct response before using temp file
const MAX_RESPONSE_SIZE = 100000;

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
function getMongoConfig() {
  return {
    host: process.env.MONGO_HOST || "localhost",
    port: parseInt(process.env.MONGO_PORT || "27017", 10),
    database: process.env.MONGO_DATABASE || "test",
    user: process.env.MONGO_USER,
    password: process.env.MONGO_PASSWORD,
  };
}

/**
 * Establishes a connection to the configured MongoDB instance.
 *
 * This function is idempotent. If the connection is already established, it
 * simply returns without doing anything. If the connection is not established,
 * it attempts to connect to the configured MongoDB instance and authenticate
 * if credentials are provided.
 *
 * In case of a connection error, it returns an object with a single "text"
 * content item with the error message.
 */
async function connectToMongoDB() {
  try {
    const config = getMongoConfig();
    client = new MongoClient(config.host, config.port);
    db = client[config.database];
    if (config.user && config.password) {
      await db.authenticate(config.user, config.password);
    }
  } catch (error) {
    return {
      contents: [
        {
          type: "text",
          text: "Failed to connect to MongoDB",
        },
      ],
    };
  }
}

async function disconnectFromMongoDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}


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
 * Writes large command results to a temporary file
 * @param data Data to write to file
 * @returns Object with file path and information
 */
async function writeResultToTempFile(data: any): Promise<{
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
    const handle = await fs.open(filePath, 'r');
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
export function validateCommand(command: string, options: Record<string, any> = {}): void {
  // Check if command is in allowlist
  if (!ALLOWED_COMMANDS.includes(command as any)) {
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
    if (key !== command && ALLOWED_COMMANDS.includes(key as any)) {
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
  options: Record<string, any> = {}
): Promise<any> {
  try {
    // Extract options that control response handling
    const outputToFile = !!options.outputToFile;
    const forceOutput = !!options.forceOutput;
    
    // Remove our custom options before passing to MongoDB
    const cleanOptions = { ...options };
    delete cleanOptions.outputToFile;
    delete cleanOptions.forceOutput;
    
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
    
    // Execute the validated command
    const result = await db.command(commandObj);
    
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
        description: "Command options with additional parameters: outputToFile (boolean) to write large results to a temp file, forceOutput (boolean) to force direct output"
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
