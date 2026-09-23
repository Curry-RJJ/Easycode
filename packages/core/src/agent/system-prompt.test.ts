/**
 * F-02 单元测试：buildSystemPrompt + loadProjectMemory
 *
 * 验收标准（来自 flesh-blood-plan.md F-02）：
 *   1. 系统提示词包含 Identity / Core Rules / Tool Guide / Safety 四大段
 *   2. 包含工作目录信息
 *   3. 每个工具的使用指南都在提示词中出现
 *   4. loadProjectMemory 能正确读取 CLAUDE.md 并注入提示词
 *   5. 无 CLAUDE.md 时正常工作（不报错）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildSystemPrompt } from './system-prompt.js';
import { loadProjectMemory } from '../context/project-memory.js';

// ─── buildSystemPrompt ────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('包含 Identity 段（工作目录、平台信息）', () => {
    const prompt = buildSystemPrompt({ projectRoot: '/test/project' });
    expect(prompt).toContain('EasyCode');
    expect(prompt).toContain('/test/project');
    expect(prompt).toContain('Platform:');
  });

  it('包含 Core Rules 段', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Core Behavior');
    expect(prompt).toContain('Think before acting');
    expect(prompt).toContain('Minimal changes');
    expect(prompt).toContain('Verify your work');
  });

  it('包含所有 6 个工具的使用指南', () => {
    const prompt = buildSystemPrompt();
    // 六个内置工具
    expect(prompt).toContain('### read_file');
    expect(prompt).toContain('### write_file');
    expect(prompt).toContain('### edit_file');
    expect(prompt).toContain('### run_bash');
    expect(prompt).toContain('### list_dir');
    expect(prompt).toContain('### search_files');
  });

  it('包含安全边界段', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Safety Rules');
    expect(prompt).toContain('rm -rf');
    expect(prompt).toContain('API key');
  });

  it('注入 projectMemory 时出现在提示词中', () => {
    const memory = '# 项目规范\n- 使用 TypeScript strict 模式\n- 禁止 console.log';
    const prompt = buildSystemPrompt({ projectMemory: memory });
    expect(prompt).toContain('Project Context');
    expect(prompt).toContain('使用 TypeScript strict 模式');
    expect(prompt).toContain('禁止 console.log');
  });

  it('没有 projectMemory 时不出现 Project Context 段', () => {
    const prompt = buildSystemPrompt({ projectMemory: '' });
    expect(prompt).not.toContain('Project Context');
  });

  it('各段用分隔符 --- 分开', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('---');
  });
});

// ─── loadProjectMemory ────────────────────────────────────────────────

describe('loadProjectMemory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `ec_test_${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('目录中无 CLAUDE.md 时返回空字符串', () => {
    const result = loadProjectMemory(testDir);
    expect(result).toBe('');
  });

  it('找到 CLAUDE.md 时返回其内容', () => {
    const content = '# My Project\n\n禁止修改 package.json';
    writeFileSync(join(testDir, 'CLAUDE.md'), content, 'utf-8');

    const result = loadProjectMemory(testDir);
    expect(result).toContain('禁止修改 package.json');
    expect(result).toContain('CLAUDE.md');
  });

  it('找到 AGENTS.md 时返回其内容', () => {
    const content = '# Agent Rules\n\nAlways use edit_file';
    writeFileSync(join(testDir, 'AGENTS.md'), content, 'utf-8');

    const result = loadProjectMemory(testDir);
    expect(result).toContain('Always use edit_file');
  });

  it('子目录的 CLAUDE.md 在结果中排在父目录前面', () => {
    const parentContent = '# Parent Rules';
    const childContent = '# Child Rules';

    writeFileSync(join(testDir, 'CLAUDE.md'), parentContent, 'utf-8');

    const childDir = join(testDir, 'subproject');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, 'CLAUDE.md'), childContent, 'utf-8');

    const result = loadProjectMemory(childDir);
    // 子目录的 CLAUDE.md 优先（unshift 保证子目录先）
    const childIdx = result.indexOf('Child Rules');
    const parentIdx = result.indexOf('Parent Rules');
    expect(childIdx).toBeLessThan(parentIdx);
  });

  it('文件超过 10000 chars 时截断', () => {
    const bigContent = 'x'.repeat(15_000);
    writeFileSync(join(testDir, 'CLAUDE.md'), bigContent, 'utf-8');

    const result = loadProjectMemory(testDir);
    expect(result.length).toBeLessThan(15_000);
    expect(result).toContain('[truncated]');
  });
});
