import { z } from "zod";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";

// MongoDB Command Tool Schema
export const MongoCommandToolSchema = ToolSchema.extend({
  inputSchema: z.object({
    type: z.literal("object"),
    properties: z.object({
      command: z.string(),
      options: z.record(z.unknown()).optional(),
    }).passthrough(),
    required: z.array(z.literal("command")),
  }),
});

export type MongoCommandTool = z.infer<typeof MongoCommandToolSchema>;

// List of allowed MongoDB commands (read-only/safe commands)
export const ALLOWED_COMMANDS = [
  "dbStats", 
  "collStats", 
  "serverStatus",
  "buildInfo",
  "connectionStatus",
  "ping",
  "hello",
  "hostInfo",
  "listCommands",
  "features",
  "connect",
  "disconnect"
] as const;

export type AllowedCommand = typeof ALLOWED_COMMANDS[number];

// Potentially dangerous MongoDB operators
export const DANGEROUS_OPERATORS = [
  '$where',
  '$function',
  '$accumulator',
  '$map',
  '$merge',
  '$out',
  '$lookup',
  '$graphLookup'
] as const;

// MongoDB Command Error Types
export const MongoCommandErrorCodeSchema = z.enum([
  "COMMAND_NOT_ALLOWED",
  "INVALID_COMMAND_STRUCTURE",
  "DANGEROUS_OPERATION",
  "EXECUTION_ERROR",
  "FILE_OPERATION_ERROR", // Added for file operations
  "CONNECTION_ERROR",
  "TIMEOUT_ERROR" // Added for request timeouts
]);

export type MongoCommandErrorCode = z.infer<typeof MongoCommandErrorCodeSchema>;

export const MongoCommandErrorSchema = z.object({
  code: MongoCommandErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});

export type MongoCommandError = z.infer<typeof MongoCommandErrorSchema>;
