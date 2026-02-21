/**
 * Template copying utilities
 */

import {
  existsSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "fs";
import { join, dirname, extname, relative } from "path";
import { fileURLToPath } from "url";
import { createLogger } from "./logger";

const logger = createLogger("templates");

// Get templates directory (relative to project root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, "../../templates");

/**
 * Template variables that can be substituted in template files
 */
export interface TemplateVariables {
  memory_mode?: "shared" | "isolated";
  agent_id?: string;
  agent_name?: string;
}

/**
 * Replace template variables in content
 */
function replaceTemplateVariables(content: string, variables: TemplateVariables): string {
  let result = content;

  if (variables.memory_mode) {
    result = result.replace(/\{\{memory_mode\}\}/g, variables.memory_mode);
  }

  if (variables.agent_id) {
    result = result.replace(/\{\{agent_id\}\}/g, variables.agent_id);
  }

  if (variables.agent_name) {
    result = result.replace(/\{\{agent_name\}\}/g, variables.agent_name);
  }

  return result;
}

/**
 * Copy template files to agent workspace
 * Discovers and copies all .md files from templates directory
 * Only copies if file doesn't already exist (non-destructive)
 * Supports variable substitution with {{variable_name}} syntax
 */
export function copyTemplatesToAgent(workspaceDir: string, variables: TemplateVariables = {}): void {
  // Check if templates directory exists
  if (!existsSync(TEMPLATES_DIR)) {
    logger.warn("Templates directory not found", { path: TEMPLATES_DIR });
    return;
  }

  // Discover all .md files in templates directory
  const templateFiles = readdirSync(TEMPLATES_DIR).filter(
    (file) => extname(file).toLowerCase() === ".md"
  );

  logger.debug("Discovered template files", { count: templateFiles.length, files: templateFiles });

  let copiedCount = 0;
  let skippedCount = 0;

  for (const templateFile of templateFiles) {
    const sourcePath = join(TEMPLATES_DIR, templateFile);

    try {
      // All .md files go in workspace root
      const destPath = join(workspaceDir, templateFile);

      if (!existsSync(destPath)) {
        // Read template, perform variable substitution, write to destination
        const templateContent = readFileSync(sourcePath, "utf-8");
        const processedContent = replaceTemplateVariables(templateContent, variables);
        writeFileSync(destPath, processedContent, "utf-8");
        logger.debug("Copied template to workspace", { file: templateFile });
        copiedCount++;
      } else {
        logger.debug("Skipped existing file", { file: templateFile, location: "workspace" });
        skippedCount++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to copy template", { file: templateFile, error: message });
      // Continue with other templates
    }
  }

  logger.info("Template copying completed", {
    workspace: workspaceDir,
    copied: copiedCount,
    skipped: skippedCount,
    total: templateFiles.length,
  });
}

const MEMORY_INITIAL_CONTENT =
  `# Memory\n\nNotes consolidated from daily logs. Maintained automatically by the memory skill.\n`;

export function setupAgentMemory(
  mode: "shared" | "isolated",
  agentWorkspaceDir: string,
  sharedMemoryDir?: string
): void {
  if (mode === "shared") {
    if (!sharedMemoryDir) {
      throw new Error("sharedMemoryDir is required in shared mode");
    }

    // Ensure shared memory dir has the full structure (idempotent — safe to call multiple times)
    mkdirSync(join(sharedMemoryDir, "daily"), { recursive: true });
    const sharedMemoryFile = join(sharedMemoryDir, "MEMORY.md");
    if (!existsSync(sharedMemoryFile)) {
      writeFileSync(sharedMemoryFile, MEMORY_INITIAL_CONTENT, "utf-8");
    }

    // Symlink agent_workspace/memory → shared memory dir (relative, skip if already exists)
    const symlinkPath = join(agentWorkspaceDir, "memory");
    if (!existsSync(symlinkPath)) {
      symlinkSync(relative(agentWorkspaceDir, sharedMemoryDir), symlinkPath);
    }
  } else {
    // Isolated: create memory structure directly in the agent workspace
    const memoryDir = join(agentWorkspaceDir, "memory");
    mkdirSync(join(memoryDir, "daily"), { recursive: true });
    const memoryFile = join(memoryDir, "MEMORY.md");
    if (!existsSync(memoryFile)) {
      writeFileSync(memoryFile, MEMORY_INITIAL_CONTENT, "utf-8");
    }
  }
}

export function setupAgentWorkspace(agentWorkspaceDir: string, skillsSourceDir: string): void {
  const skillsDestDir = join(agentWorkspaceDir, ".claude", "skills");
  mkdirSync(skillsDestDir, { recursive: true });

  const entries = readdirSync(skillsSourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsSourceDir, entry.name, "SKILL.md");
    if (existsSync(skillFile)) {
      copyFileSync(skillFile, join(skillsDestDir, entry.name));
    }
  }
}
