#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { installInstrumentation, scanState, writeArtifactBundle } from '@nexus/extractor';
import { type Browser, chromium } from 'playwright';

export interface ExtractCommand {
  command: 'extract';
  url: string;
  outputDirectory: string;
}

export interface RunCliDependencies {
  launchBrowser?: () => Promise<Browser>;
  scan?: typeof scanState;
  writeBundle?: typeof writeArtifactBundle;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
}

const HELP = `Usage:
  pnpm nexus extract <url> [--out <directory>]

Options:
  --out <directory>  Artifact directory (default: ./.nexus)
  --help             Show this help message`;

export function parseCliArgs(
  argv: string[],
  currentWorkingDirectory = process.cwd(),
): ExtractCommand | null {
  if (argv.includes('--help') || argv.includes('-h')) {
    return null;
  }

  if (argv[0] !== 'extract') {
    throw new Error('Expected the `extract` command.');
  }

  const requestedUrl = argv[1];
  if (requestedUrl === undefined || requestedUrl.startsWith('-')) {
    throw new Error('The extract command requires a URL.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(requestedUrl);
  } catch {
    throw new Error(`Invalid URL: ${requestedUrl}`);
  }

  if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
  }

  let outputDirectory = resolve(currentWorkingDirectory, '.nexus');
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--out') {
      throw new Error(`Unknown argument: ${argument ?? ''}`);
    }

    const output = argv[index + 1];
    if (output === undefined || output.startsWith('-')) {
      throw new Error('The --out option requires a directory.');
    }
    outputDirectory = resolve(currentWorkingDirectory, output);
    index += 1;
  }

  return {
    command: 'extract',
    url: parsedUrl.href,
    outputDirectory,
  };
}

export async function runCli(
  argv = process.argv.slice(2),
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  let command: ExtractCommand | null;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`nexus: ${message}\n\n${HELP}`);
    return 1;
  }

  if (command === null) {
    stdout(HELP);
    return 0;
  }

  const browser = await (dependencies.launchBrowser ?? (() => chromium.launch({ headless: true })))();
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await installInstrumentation(page);
      await page.goto(command.url, { waitUntil: 'domcontentloaded' });
      const artifact = await (dependencies.scan ?? scanState)(page);
      const paths = await (dependencies.writeBundle ?? writeArtifactBundle)(
        command.outputDirectory,
        artifact,
      );

      stdout(
        JSON.stringify(
          {
            stateId: artifact.stateId,
            artifact: paths.state,
          },
          null,
          2,
        ),
      );
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }

  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(`nexus: extraction failed\n${message}`);
      process.exitCode = 1;
    });
}
