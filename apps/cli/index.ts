/**
 * ARTHUR CLI (spec section 14).
 *
 * A thin entry point over the same core services the HTTP API uses. It contains
 * no second implementation of orchestration.
 *
 *   arthur chat --mode personal|business [--session <id>]
 *   arthur status
 *   arthur session <id>
 *   arthur approve <approval-id>
 *   arthur reject <approval-id>
 */

import { createInterface, Interface } from "node:readline";

import { buildApp } from "../../src/app";
import { ArthurError, sanitizePublicError } from "../../src/core/errors/errors";
import { isSecretLikeKey } from "../../src/security/redaction";
import { SecretSanitizer } from "../../src/security/sanitize";
import { isArthurMode, ArthurMode } from "../../src/core/modes/mode";
import { loadDotEnv } from "../../src/config/settings";
import { newId } from "../../src/observability/tracing";
import { parseTypeLabel } from "../../src/memory/api";
import type { MemoryStatusReport } from "../../src/memory/contracts";
import type { App } from "../../src/app";

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags.set(arg.slice(2), next);
          i++;
        } else {
          flags.set(arg.slice(2), "true");
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command: positionals[0] ?? "", flags, positionals };
}

const HELP = `ARTHUR CLI

Usage:
  arthur chat --mode personal|business [--session <id>]   Start a conversation
  arthur status                                           Show version/provider status
  arthur session <id>                                     Show a session and its history
  arthur approve <approval-id>                            Approve one pending tool action
  arthur reject <approval-id>                             Reject one pending tool action
  arthur memory remember --session <id> [--type <t>] [--subject <k>] [--project <k>] "<text>"
  arthur memory search --session <id> "<query>"
  arthur memory list --session <id>
  arthur memory forget --session <id> <memory-id>
  arthur memory status --session <id>
  arthur documents add --session <id> --file <path> [--title <t>] [--project <k>]
  arthur documents list --session <id>
`;

async function runMemoryCommands(
  app: App,
  command: string,
  flags: Map<string, string>,
  positionals: string[],
): Promise<void> {
  const sessionId = flags.get("session");
  if (!sessionId) {
    process.stderr.write("usage: arthur memory <command> --session <id> ...\n");
    return;
  }
  switch (command) {
    case "remember": {
      // positionals = [command, subcommand, text...]
      const text = positionals[2];
      if (!text) {
        process.stderr.write('usage: arthur memory remember --session <id> [--type semantic] "<text>"\n');
        return;
      }
      const rawType = flags.get("type") ?? "semantic";
      const item = await app.memory.remember(sessionId, {
        text,
        type: parseTypeLabel(rawType),
        subject_key: flags.get("subject"),
        project_key: flags.get("project"),
        client_request_id: newId(),
      });
      printJson({ memory_id: item.id, status: item.status, type: item.type, text: item.display_text });
      return;
    }
    case "search": {
      const query = positionals[2];
      if (!query) {
        process.stderr.write('usage: arthur memory search --session <id> "<query>"\n');
        return;
      }
      const memories = await app.memory.search(sessionId, { query_text: query, top_k: 8 });
      printJson({ memories });
      return;
    }
    case "list": {
      const memories = await app.memory.list(sessionId, { domain: "personal", limit: 100 });
      printJson({ memories });
      return;
    }
    case "forget": {
      const memoryId = positionals[2];
      if (!memoryId) {
        process.stderr.write("usage: arthur memory forget --session <id> <memory-id>\n");
        return;
      }
      await app.memory.forget(sessionId, memoryId);
      printJson({ status: "deleted", memory_id: memoryId });
      return;
    }
    case "status": {
      const report: MemoryStatusReport = app.memory.status(sessionId);
      printJson(report);
      return;
    }
    default: {
      process.stderr.write(`unknown memory command: ${command}\n`);
      process.exitCode = 1;
    }
  }
}

async function runDocumentCommands(
  app: App,
  command: string,
  flags: Map<string, string>,
  positionals: string[],
): Promise<void> {
  const sessionId = flags.get("session");
  if (!sessionId) {
    process.stderr.write("usage: arthur documents <command> --session <id> ...\n");
    return;
  }
  switch (command) {
    case "add": {
      const filePath = flags.get("file");
      if (!filePath) {
        process.stderr.write("usage: arthur documents add --session <id> --file <path> [--title <t>]\n");
        return;
      }
      const fs = require("node:fs") as typeof import("node:fs");
      const content = fs.readFileSync(filePath, "utf8");
      const title = flags.get("title") ?? filePath.split(/[\\/]/).pop() ?? filePath;
      const document = await app.memory.ingestDocument(
        sessionId,
        { title, source_type: "text", content, project_key: flags.get("project") },
        newId(),
      );
      printJson(document);
      return;
    }
    case "list": {
      const documents = await app.memory.listDocuments(sessionId);
      printJson({ documents });
      return;
    }
    default: {
      process.stderr.write(`unknown documents command: ${command}\n`);
      process.exitCode = 1;
    }
  }
}

function startupSanitizer(): SecretSanitizer {
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => isSecretLikeKey(key) && Boolean(value))
    .map(([, value]) => value as string);
  return new SecretSanitizer(secrets);
}

export function renderCliError(err: unknown, app?: App): string {
  const publicError = app ? app.sanitizePublicError(err) : sanitizePublicError(err, startupSanitizer());
  return `error [${publicError.body.error.code}]: ${publicError.body.error.message}\n`;
}

function printError(err: unknown, app?: App): void {
  process.stderr.write(renderCliError(err, app));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runChat(app: App, mode: ArthurMode, sessionId?: string): Promise<void> {
  const rl: Interface = createInterface({ input: process.stdin, output: process.stdout });
  let currentSessionId = sessionId;
  process.stdout.write(`ARTHUR chat (${mode} mode). Type a message, or "exit" to quit.\n`);
  if (process.stdin.isTTY) {
    rl.setPrompt("you> ");
    rl.prompt();
  }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (process.stdin.isTTY) rl.prompt();
      continue;
    }
    if (trimmed === "exit" || trimmed === "/exit") {
      break;
    }
    try {
      const response = await app.conversation.handleTurn({
        session_id: currentSessionId,
        mode,
        message: trimmed,
        client_request_id: newId(),
        metadata: { client_type: "cli" },
      });
      if (currentSessionId === undefined) {
        // First turn of a brand-new session: surface the id so memory commands
        // can target it (e.g. arthur memory remember --session <id> ...).
        process.stdout.write(`[session id: ${response.session_id}]\n`);
      }
      currentSessionId = response.session_id;
      process.stdout.write(`arthur> ${response.display_text}\n`);
      for (const toolCall of response.tool_calls) {
        if (toolCall.status === "pending_approval") {
          process.stdout.write(
            `        [pending approval] ${toolCall.name} -> approve ${toolCall.approval_id}\n`,
          );
        } else if (toolCall.status === "rejected") {
          process.stdout.write(`        [rejected] ${toolCall.name}: ${toolCall.result_summary ?? ""}\n`);
        }
      }
    } catch (err) {
      printError(err, app);
    }
    if (process.stdin.isTTY) rl.prompt();
  }
  rl.close();
}

async function main(): Promise<void> {
  const { command, flags, positionals } = parseArgs(process.argv.slice(2));

  if (command === "" || command === "help" || command === "--help") {
    process.stdout.write(HELP);
    return;
  }

  let app: App;
  try {
    loadDotEnv();
    app = buildApp();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(new ArthurError("INVALID_CONFIG", message));
    process.exitCode = 1;
    return;
  }

  try {
    switch (command) {
      case "chat": {
        const rawMode = flags.get("mode") ?? "personal";
        if (!isArthurMode(rawMode)) {
          printError(new ArthurError("INVALID_REQUEST", "Invalid mode; expected personal or business"), app);
          return;
        }
        await runChat(app, rawMode, flags.get("session"));
        break;
      }
      case "status": {
        printJson(app.conversation.getStatus());
        break;
      }
      case "session": {
        const id = positionals[1];
        if (!id) {
          process.stderr.write("usage: arthur session <id>\n");
          return;
        }
        printJson(await app.conversation.getSession(id));
        break;
      }
      case "approve": {
        const id = positionals[1];
        if (!id) {
          process.stderr.write("usage: arthur approve <approval-id>\n");
          return;
        }
        printJson(await app.conversation.approve(id));
        break;
      }
      case "reject": {
        const id = positionals[1];
        if (!id) {
          process.stderr.write("usage: arthur reject <approval-id>\n");
          return;
        }
        printJson(await app.conversation.reject(id));
        break;
      }
      case "memory": {
        await runMemoryCommands(app, positionals[1] ?? "", flags, positionals);
        break;
      }
      case "documents": {
        await runDocumentCommands(app, positionals[1] ?? "", flags, positionals);
        break;
      }
      default: {
        process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
        process.exitCode = 1;
      }
    }
  } catch (err) {
    printError(err, app);
    process.exitCode = 1;
  } finally {
    app.close();
  }
}

if (require.main === module) {
  void main();
}