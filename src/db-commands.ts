/**
 * MongoDB database command handler with security controls
 */
import { Db } from "mongodb";
import { 
  ALLOWED_COMMANDS, 
  DANGEROUS_OPERATORS,
  MongoCommandError,
  MongoCommandErrorCode
} from "./db-command-types.js";

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
 * @returns The command result
 * @throws MongoCommandError if validation or execution fails
 */
export async function executeCommand(
  db: Db, 
  command: string, 
  options: Record<string, any> = {}
): Promise<any> {
  try {
    // Perform security validation
    validateCommand(command, options);

    console.error('executeCommand -> ',command, options);
    
    // Build the command object with the command name as a key
    let commandObj;
    
    if (command === 'collStats') {
      // For collStats, the value should be the collection name
      const collName = options?.collection || options?.collStats;
      commandObj = { [command]: collName, ...options };
      // Remove duplicate options
      if ('collection' in commandObj) {
        delete commandObj.collection;
      }
      if ('collStats' in commandObj) {
        delete commandObj.collStats;
      }
    } else if (command === 'dbStats') {
      // For dbStats, typically no collection is needed
      commandObj = { [command]: 1, ...options };
    } else {
      // Default case for other commands
      commandObj = { [command]: options?.collection || 1, ...options };
    }
    
    // Execute the validated command
    return await db.command(commandObj);
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
        description: "Command options"
      }
    },
    required: ["command"]
  }
};
