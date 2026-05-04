/**
 * Language Detection — maps file paths to SupportedLanguages enum values.
 */

import { SupportedLanguages } from '../../../config/supported-languages.js';
import { isConfigFile } from '../config-indexer.js';

/** Ruby extensionless filenames recognised as Ruby source */
const RUBY_EXTENSIONLESS_FILES = new Set(['Rakefile', 'Gemfile', 'Guardfile', 'Vagrantfile', 'Brewfile']);

/**
 * Map file extension to SupportedLanguage enum.
 * Returns null if the file extension is not recognized.
 */
export const getLanguageFromFilename = (filename: string): SupportedLanguages | null => {
  // TypeScript (including TSX)
  if (filename.endsWith('.tsx')) return SupportedLanguages.TypeScript;
  if (filename.endsWith('.ts')) return SupportedLanguages.TypeScript;
  // JavaScript (including JSX)
  if (filename.endsWith('.jsx')) return SupportedLanguages.JavaScript;
  if (filename.endsWith('.js')) return SupportedLanguages.JavaScript;
  // Python
  if (filename.endsWith('.py')) return SupportedLanguages.Python;
  // Java
  if (filename.endsWith('.java')) return SupportedLanguages.Java;
  // C source files
  if (filename.endsWith('.c')) return SupportedLanguages.C;
  // C++ (all common extensions, including .h)
  // .h is parsed as C++ because tree-sitter-cpp is a strict superset of C, so pure-C
  // headers parse correctly, and C++ headers (classes, templates) are handled properly.
  if (filename.endsWith('.cpp') || filename.endsWith('.cc') || filename.endsWith('.cxx') ||
      filename.endsWith('.h') || filename.endsWith('.hpp') || filename.endsWith('.hxx') || filename.endsWith('.hh')) return SupportedLanguages.CPlusPlus;
  // C#
  if (filename.endsWith('.cs')) return SupportedLanguages.CSharp;
  // Go
  if (filename.endsWith('.go')) return SupportedLanguages.Go;
  // Rust
  if (filename.endsWith('.rs')) return SupportedLanguages.Rust;
  // Kotlin
  if (filename.endsWith('.kt') || filename.endsWith('.kts')) return SupportedLanguages.Kotlin;
  // PHP (all common extensions)
  if (filename.endsWith('.php') || filename.endsWith('.phtml') ||
      filename.endsWith('.php3') || filename.endsWith('.php4') ||
      filename.endsWith('.php5') || filename.endsWith('.php8')) {
    return SupportedLanguages.PHP;
  }
  // Ruby (extensions)
  if (filename.endsWith('.rb') || filename.endsWith('.rake') || filename.endsWith('.gemspec')) {
    return SupportedLanguages.Ruby;
  }
  // Ruby (extensionless files)
  const basename = filename.split('/').pop() || filename;
  if (RUBY_EXTENSIONLESS_FILES.has(basename)) {
    return SupportedLanguages.Ruby;
  }
  // Swift (extensions)
  if (filename.endsWith('.swift')) return SupportedLanguages.Swift;
  if (filename.endsWith('.dart')) return SupportedLanguages.Dart;
  return null;
};
/**
 * Classify a file path into a broad type category.
 *
 * Priority: code > documentation > config > data > other.
 * Code classification delegates to getLanguageFromFilename.
 */
export function getFileType(filePath: string): 'code' | 'documentation' | 'config' | 'data' | 'other' {
  // Code — any file recognized by language detection
  if (getLanguageFromFilename(filePath) !== null) {
    return 'code';
  }

  const filename = filePath.split('/').pop() || '';

  // Documentation
  if (filename.endsWith('.md') || filename.endsWith('.mdx') ||
      filename.endsWith('.rst') || filename.endsWith('.adoc') ||
      filename.endsWith('.txt')) {
    return 'documentation';
  }

  // Config — by extension or by config filename pattern
  if (filename.endsWith('.xml') || filename.endsWith('.toml') ||
      filename.endsWith('.yaml') || filename.endsWith('.yml') ||
      filename.endsWith('.properties') || filename.endsWith('.ini') ||
      filename.endsWith('.cfg')) {
    return 'config';
  }
  if (isConfigFile(filePath)) {
    return 'config';
  }

  // Data — JSON (excluding lock files) and CSV
  if (filename.endsWith('.json')) {
    if (filename.endsWith('-lock.json') || filename === 'package-lock.json') {
      return 'other';
    }
    return 'data';
  }
  if (filename.endsWith('.csv')) {
    return 'data';
  }

  return 'other';
}
