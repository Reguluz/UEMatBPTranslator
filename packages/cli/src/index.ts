#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { translate } from '@ue-material-translator/core';

const HELP = `UE Material Translator

Usage: ue-material [input.txt|-] [options]

Read copied UE material node text from a file or standard input.
HLSL is written to standard output unless --out is supplied.

Options:
  --engine 5.5|5.7               UE semantics profile (default: 5.7)
  --shading-path <path>          preserve, deferred, forward, or mobile (default: preserve)
  --out <file.hlsl>              Save generated HLSL
  --report <file.json>           Save the complete translation result
  --output <candidate-id>        Select an output; may be repeated
  --input-type <source-id=type>  Type an external source; may be repeated
  --static-parameters <json>     Load static parameter name -> boolean overrides
  --module <node-id=comment-id>  Override module ownership; '-' removes grouping
  --list-outputs                Print available output candidates as JSON
  --module-style <style>        auto, scopes, or functions (default: auto)
  --strict                      Fail unless translation is complete
  -h, --help                    Show this help

Exit codes:
  0  Complete, or external dependencies allowed without --strict
  1  Unsupported translation, or incomplete translation with --strict
  2  Invalid arguments or input/output failure

Examples:
  ue-material copied.txt --engine 5.5 --out material.hlsl
  ue-material copied.txt --list-outputs
  ue-material copied.txt --output MaterialExpressionMultiply_0:0
  Get-Content -Raw copied.txt | ue-material --engine 5.7
`;

type TranslationOptions = NonNullable<Parameters<typeof translate>[1]>;

interface Arguments {
  input?: string;
  out?: string;
  report?: string;
  staticParameters?: string;
  help: boolean;
  listOutputs: boolean;
  strict: boolean;
  translation: TranslationOptions;
}

class UsageError extends Error {}

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = {
    help: false,
    listOutputs: false,
    strict: false,
    translation: { engineVersion: '5.7', moduleStyle: 'auto' },
  };
  const seen = new Set<string>();
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === '--' && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || argument === '-' || !argument.startsWith('-')) {
      if (result.input !== undefined) throw new UsageError('Only one input file can be supplied.');
      result.input = argument;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--strict' || argument === '--list-outputs') {
      if (argument === '--strict') result.strict = true;
      else result.listOutputs = true;
      continue;
    }
    if (!['--engine', '--shading-path', '--out', '--report', '--output', '--input-type', '--static-parameters', '--module', '--module-style'].includes(argument)) {
      throw new UsageError(`Unknown option: ${argument}`);
    }
    if (!['--output', '--input-type', '--module'].includes(argument) && seen.has(argument)) {
      throw new UsageError(`Option supplied more than once: ${argument}`);
    }
    seen.add(argument);
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new UsageError(`Missing value for ${argument}.`);
    }
    switch (argument) {
      case '--engine':
        if (value !== '5.5' && value !== '5.7') throw new UsageError('--engine must be 5.5 or 5.7.');
        result.translation.engineVersion = value;
        break;
      case '--shading-path':
        if (value !== 'preserve' && value !== 'deferred' && value !== 'forward' && value !== 'mobile') throw new UsageError('--shading-path must be preserve, deferred, forward, or mobile.');
        result.translation.shadingPath = value;
        break;
      case '--out': result.out = value; break;
      case '--report': result.report = value; break;
      case '--static-parameters': result.staticParameters = value; break;
      case '--output':
        (result.translation.outputs ??= []).push(value);
        break;
      case '--input-type': {
        const separator = value.lastIndexOf('=');
        const sourceId = value.slice(0, separator);
        const type = value.slice(separator + 1);
        if (separator < 1 || !['float', 'float2', 'float3', 'float4', 'bool', 'Texture2D', 'Texture3D'].includes(type)) {
          throw new UsageError('--input-type expects source-id=type; type must be float, float2, float3, float4, bool, Texture2D, or Texture3D.');
        }
        result.translation.externalInputs ??= {};
        if (Object.prototype.hasOwnProperty.call(result.translation.externalInputs, sourceId)) {
          throw new UsageError(`External input type supplied more than once: ${sourceId}`);
        }
        Object.defineProperty(result.translation.externalInputs, sourceId, {
          value: type, enumerable: true, configurable: true, writable: true,
        });
        break;
      }
      case '--module': {
        const separator = value.lastIndexOf('=');
        const nodeId = value.slice(0, separator);
        const commentId = value.slice(separator + 1);
        if (separator < 1 || !commentId) {
          throw new UsageError('--module expects node-id=comment-id, or node-id=- to remove grouping.');
        }
        result.translation.moduleAssignments ??= {};
        if (Object.prototype.hasOwnProperty.call(result.translation.moduleAssignments, nodeId)) {
          throw new UsageError(`Module assignment supplied more than once: ${nodeId}`);
        }
        Object.defineProperty(result.translation.moduleAssignments, nodeId, {
          value: commentId === '-' ? null : commentId,
          enumerable: true, configurable: true, writable: true,
        });
        break;
      }
      case '--module-style':
        if (value !== 'auto' && value !== 'scopes' && value !== 'functions') {
          throw new UsageError('--module-style must be auto, scopes, or functions.');
        }
        result.translation.moduleStyle = value;
        break;
    }
  }
  if (result.listOutputs && result.out) {
    throw new UsageError('--list-outputs cannot be combined with --out.');
  }
  return result;
}

// Resolve existing aliases (symlinks/junctions) as well as ordinary relative paths.
function canonicalPath(file: string): string {
  let absolute = path.resolve(file);
  const suffix: string[] = [];
  while (!fs.existsSync(absolute)) {
    const parent = path.dirname(absolute);
    if (parent === absolute) break;
    suffix.unshift(path.basename(absolute));
    absolute = parent;
  }
  if (fs.existsSync(absolute)) absolute = fs.realpathSync.native(absolute);
  absolute = path.join(absolute, ...suffix);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function sameFile(first: string, second: string): boolean {
  if (canonicalPath(first) === canonicalPath(second)) return true;
  // Hard links have distinct paths, but writing one would also overwrite the input.
  if (fs.existsSync(first) && fs.existsSync(second)) {
    const a = fs.statSync(first);
    const b = fs.statSync(second);
    if (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev) return true;
  }
  return false;
}

function validateDestinations(args: Arguments): void {
  const destinations = [args.out, args.report].filter((value): value is string => value !== undefined);
  for (const destination of destinations) {
    if (args.input && args.input !== '-' && sameFile(args.input, destination)) {
      throw new UsageError(`Refusing to overwrite input file: ${destination}`);
    }
    if (args.staticParameters && sameFile(args.staticParameters, destination)) {
      throw new UsageError(`Refusing to overwrite static parameter file: ${destination}`);
    }
    const parent = path.dirname(path.resolve(destination));
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new UsageError(`Output directory does not exist: ${parent}`);
    }
    if (fs.existsSync(destination) && !fs.statSync(destination).isFile()) {
      throw new UsageError(`Output destination is not a file: ${destination}`);
    }
  }
  if (args.out && args.report && sameFile(args.out, args.report)) {
    throw new UsageError('--out and --report must refer to different files.');
  }
}

function readStaticParameters(file: string): Record<string, boolean> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError('--static-parameters expects a JSON object mapping parameter names to boolean values.');
  }
  const entries = Object.entries(value);
  if (entries.some(([name, selected]) => !name.trim() || typeof selected !== 'boolean')) {
    throw new UsageError('--static-parameters entries must have non-empty parameter names and boolean values.');
  }
  return Object.fromEntries(entries);
}

function main(): number {
  let args: Arguments;
  let source: string;
  try {
    args = parseArguments(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(HELP);
      return 0;
    }
    validateDestinations(args);
    if (args.staticParameters) args.translation.staticParameters = readStaticParameters(args.staticParameters);
    if ((!args.input || args.input === '-') && process.stdin.isTTY) {
      throw new UsageError('Supply an input file or pipe copied node text through standard input.');
    }
    source = fs.readFileSync(args.input && args.input !== '-' ? args.input : 0, 'utf8');
  } catch (error) {
    process.stderr.write(`ue-material: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  try {
    const result = translate(source.replace(/^\uFEFF/, ''), args.translation);
    for (const diagnostic of result.diagnostics) {
      const location = diagnostic.range ? `:${diagnostic.range.startLine}` : '';
      const node = diagnostic.nodeId ? ` [${diagnostic.nodeId}]` : '';
      process.stderr.write(`${diagnostic.severity} ${diagnostic.code}${location}${node}: ${diagnostic.message}\n`);
    }
    try {
      if (args.report) fs.writeFileSync(args.report, JSON.stringify(result, null, 2) + '\n', 'utf8');
      if (args.listOutputs) {
        process.stdout.write(JSON.stringify(result.candidates, null, 2) + '\n');
      } else if (args.out) {
        fs.writeFileSync(args.out, result.hlsl, 'utf8');
      } else {
        process.stdout.write(result.hlsl);
      }
    } catch (error) {
      process.stderr.write(`ue-material: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    if (result.status !== 'complete') {
      process.stderr.write(`Translation status: ${result.status}${args.strict ? ' (strict mode)' : ''}.\n`);
    }
    return result.status === 'unsupported' || (args.strict && result.status !== 'complete') ? 1 : 0;
  } catch (error) {
    process.stderr.write(`ue-material: translation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = main();
