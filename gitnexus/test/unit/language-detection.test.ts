import { describe, it, expect } from 'vitest';
import { getFileType } from '../../src/core/ingestion/utils/language-detection.js';

describe('getFileType', () => {
  // ── EP: code classification ──────────────────────────────────────────
  describe('code — recognized by getLanguageFromFilename', () => {
    it('classifies .ts as code', () => {
      expect(getFileType('src/index.ts')).toBe('code');
    });

    it('classifies .java as code', () => {
      expect(getFileType('Service.java')).toBe('code');
    });

    it('classifies .py as code', () => {
      expect(getFileType('main.py')).toBe('code');
    });

    it('classifies .rs as code', () => {
      expect(getFileType('lib.rs')).toBe('code');
    });

    it('classifies .go as code', () => {
      expect(getFileType('handler.go')).toBe('code');
    });

    it('classifies .kt as code', () => {
      expect(getFileType('App.kt')).toBe('code');
    });

    it('classifies .swift as code', () => {
      expect(getFileType('ViewController.swift')).toBe('code');
    });

    it('classifies .dart as code', () => {
      expect(getFileType('main.dart')).toBe('code');
    });

    it('classifies .c as code', () => {
      expect(getFileType('utils.c')).toBe('code');
    });

    it('classifies .cpp as code', () => {
      expect(getFileType('engine.cpp')).toBe('code');
    });

    it('classifies .cs as code', () => {
      expect(getFileType('Program.cs')).toBe('code');
    });

    it('classifies .php as code', () => {
      expect(getFileType('index.php')).toBe('code');
    });

    it('classifies .rb as code', () => {
      expect(getFileType('app.rb')).toBe('code');
    });

    it('classifies extensionless Ruby files as code', () => {
      expect(getFileType('Rakefile')).toBe('code');
      expect(getFileType('Gemfile')).toBe('code');
    });
  });

  // ── BVA: boundary extensions ────────────────────────────────────────
  describe('boundary extensions', () => {
    it('classifies .md as documentation (not code)', () => {
      expect(getFileType('README.md')).toBe('documentation');
    });

    it('classifies .properties as config (not code)', () => {
      expect(getFileType('app.properties')).toBe('config');
    });

    it('classifies .json as data (not code)', () => {
      expect(getFileType('data.json')).toBe('data');
    });
  });

  // ── EP: documentation ───────────────────────────────────────────────
  describe('documentation', () => {
    it.each([
      ['README.md', '.md'],
      ['guide.mdx', '.mdx'],
      ['CHANGELOG.rst', '.rst'],
      ['manual.adoc', '.adoc'],
      ['notes.txt', '.txt'],
    ])('classifies %s (%s) as documentation', (path) => {
      expect(getFileType(path)).toBe('documentation');
    });
  });

  // ── EP: config by extension ─────────────────────────────────────────
  describe('config — by extension', () => {
    it.each([
      ['pom.xml', '.xml'],
      ['pyproject.toml', '.toml'],
      ['docker-compose.yaml', '.yaml'],
      ['ci.yml', '.yml'],
      ['app.properties', '.properties'],
      ['setup.ini', '.ini'],
      ['app.cfg', '.cfg'],
    ])('classifies %s (%s) as config', (path) => {
      expect(getFileType(path)).toBe('config');
    });
  });

  // ── EP: config by filename pattern (isConfigFile) ───────────────────
  describe('config — by isConfigFile match', () => {
    it('classifies application.properties as config', () => {
      expect(getFileType('config/application.properties')).toBe('config');
    });

    it('classifies application-dev.yml as config', () => {
      expect(getFileType('config/application-dev.yml')).toBe('config');
    });

    it('classifies application.yaml as config', () => {
      expect(getFileType('src/main/resources/application.yaml')).toBe('config');
    });

    it('classifies application-prod.properties as config', () => {
      expect(getFileType('application-prod.properties')).toBe('config');
    });
  });

  // ── EP: data ─────────────────────────────────────────────────────────
  describe('data', () => {
    it('classifies .json as data', () => {
      expect(getFileType('data/report.json')).toBe('data');
    });

    it('classifies .csv as data', () => {
      expect(getFileType('exports/table.csv')).toBe('data');
    });
  });

  // ── EP: data lock file exclusion ────────────────────────────────────
  describe('data — lock file exclusion', () => {
    it('classifies package-lock.json as other', () => {
      expect(getFileType('package-lock.json')).toBe('other');
    });

    it('classifies *-lock.json as other', () => {
      expect(getFileType('yarn-lock.json')).toBe('other');
      expect(getFileType('pnpm-lock.json')).toBe('other');
    });

    it('classifies pnpm-lock.yaml as config (yaml, not json lock)', () => {
      expect(getFileType('pnpm-lock.yaml')).toBe('config');
    });

    it('does not misclassify regular json with "lock" in path', () => {
      expect(getFileType('src/lock-data.json')).toBe('data');
    });
  });

  // ── EP: other ───────────────────────────────────────────────────────
  describe('other', () => {
    it('classifies .exe as other', () => {
      expect(getFileType('setup.exe')).toBe('other');
    });

    it('classifies .png as other', () => {
      expect(getFileType('logo.png')).toBe('other');
    });

    it('classifies files with no extension as other', () => {
      expect(getFileType('LICENSE')).toBe('other');
    });

    it('classifies .pdf as other', () => {
      expect(getFileType('doc.pdf')).toBe('other');
    });
  });

  // ── Backward compat ─────────────────────────────────────────────────
  describe('backward compatibility', () => {
    it('unknown extension returns other', () => {
      expect(getFileType('data.xyz')).toBe('other');
    });

    it('empty string returns other', () => {
      expect(getFileType('')).toBe('other');
    });
  });
});