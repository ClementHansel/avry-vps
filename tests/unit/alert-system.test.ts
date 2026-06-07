/**
 * Unit tests for the Alert System module.
 * Tests channel configuration, rule configuration, alert emission,
 * consecutive threshold logic, history management, and delivery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initializeDatabase, closeDatabase } from '../../src/database/index.js';
import {
  createAlertSystem,
  type AlertSystem,
  type AlertChannel,
  type AlertRule,
  type AlertEvent,
} from '../../src/modules/alert-system.js';
import type Database from 'better-sqlite3';

function createTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-alert-system-test-'));
  return path.join(tmpDir, 'test.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Alert System Module', () => {
  let dbPath: string;
  let db: Database.Database;
  let alertSystem: AlertSystem;

  beforeEach(() => {
    dbPath = createTempDbPath();
    db = initializeDatabase({ dbPath });
    alertSystem = createAlertSystem(db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanupDb(dbPath);
    vi.restoreAllMocks();
  });

  describe('configureChannel', () => {
    it('should create a new email channel', async () => {
      const channel: AlertChannel = {
        type: 'email',
        config: { host: 'smtp.example.com', port: '587', user: 'test@example.com', pass: 'secret', to: 'admin@example.com' },
      };

      const id = await alertSystem.configureChannel(channel);
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe('email');
      expect(channels[0].config.host).toBe('smtp.example.com');
    });

    it('should create a new webhook channel', async () => {
      const channel: AlertChannel = {
        type: 'webhook',
        config: { url: 'https://hooks.slack.com/services/xxx', format: 'slack' },
      };

      const id = await alertSystem.configureChannel(channel);
      expect(id).toBeDefined();

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe('webhook');
      expect(channels[0].config.url).toBe('https://hooks.slack.com/services/xxx');
    });

    it('should create an in-app notification channel', async () => {
      const channel: AlertChannel = {
        type: 'in-app',
        config: {},
      };

      const id = await alertSystem.configureChannel(channel);
      expect(id).toBeDefined();

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].type).toBe('in-app');
    });

    it('should update an existing channel by ID', async () => {
      const channel: AlertChannel = {
        type: 'webhook',
        config: { url: 'https://old-url.com/hook' },
      };

      const id = await alertSystem.configureChannel(channel);

      // Update with same ID
      await alertSystem.configureChannel({
        id,
        type: 'webhook',
        config: { url: 'https://new-url.com/hook' },
      });

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].config.url).toBe('https://new-url.com/hook');
    });

    it('should support multiple channels simultaneously', async () => {
      await alertSystem.configureChannel({ type: 'email', config: { to: 'a@b.com' } });
      await alertSystem.configureChannel({ type: 'webhook', config: { url: 'https://hook.com' } });
      await alertSystem.configureChannel({ type: 'in-app', config: {} });

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(3);
    });

    it('should support disabling a channel', async () => {
      const id = await alertSystem.configureChannel({
        type: 'email',
        config: { to: 'a@b.com' },
        enabled: false,
      });

      const channels = alertSystem.getChannels();
      const channel = channels.find((c) => c.id === id);
      expect(channel?.enabled).toBe(false);
    });
  });

  describe('configureRule', () => {
    it('should create a CPU threshold rule', async () => {
      const rule: AlertRule = {
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      };

      const id = await alertSystem.configureRule(rule);
      expect(id).toBeDefined();

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].resourceType).toBe('cpu');
      expect(rules[0].threshold).toBe(80);
      expect(rules[0].consecutiveChecks).toBe(3);
    });

    it('should create a memory threshold rule', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
      });

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].resourceType).toBe('memory');
      expect(rules[0].threshold).toBe(90);
    });

    it('should default to 3 consecutive checks', async () => {
      await alertSystem.configureRule({
        resourceType: 'disk',
        threshold: 85,
      });

      const rules = alertSystem.getRules();
      expect(rules[0].consecutiveChecks).toBe(3);
    });

    it('should update an existing rule by ID', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      await alertSystem.configureRule({
        id,
        resourceType: 'cpu',
        threshold: 90,
        consecutiveChecks: 5,
      });

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(1);
      expect(rules[0].threshold).toBe(90);
      expect(rules[0].consecutiveChecks).toBe(5);
    });
  });

  describe('emitAlert', () => {
    it('should emit an alert and store it in history', async () => {
      const event: AlertEvent = {
        eventType: 'container_unhealthy',
        affectedResource: 'nginx-proxy',
        severity: 'high',
        message: 'Container nginx-proxy has become unhealthy',
      };

      const id = await alertSystem.emitAlert(event);
      expect(id).toBeDefined();

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].eventType).toBe('container_unhealthy');
      expect(history[0].affectedResource).toBe('nginx-proxy');
      expect(history[0].severity).toBe('high');
      expect(history[0].message).toBe('Container nginx-proxy has become unhealthy');
      expect(history[0].timestamp).toBeDefined();
    });

    it('should store delivery status for each channel', async () => {
      // Configure an in-app channel (will always succeed)
      await alertSystem.configureChannel({ type: 'in-app', config: {} });

      const id = await alertSystem.emitAlert({
        eventType: 'test_event',
        affectedResource: 'test',
        severity: 'low',
        message: 'Test',
      });

      const history = await alertSystem.getAlertHistory();
      expect(history[0].deliveryStatus).toBeDefined();
      expect(typeof history[0].deliveryStatus).toBe('object');
    });

    it('should trigger in-app notification callback', async () => {
      const callback = vi.fn();
      const system = createAlertSystem(db, { onInAppNotification: callback });

      await system.configureChannel({ type: 'in-app', config: {} });
      await system.emitAlert({
        eventType: 'test',
        affectedResource: 'resource',
        severity: 'medium',
        message: 'Test message',
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'test',
          affectedResource: 'resource',
          severity: 'medium',
        })
      );
    });

    it('should handle alerts with no configured channels', async () => {
      const id = await alertSystem.emitAlert({
        eventType: 'test',
        affectedResource: 'resource',
        severity: 'low',
        message: 'No channels configured',
      });

      expect(id).toBeDefined();
      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].deliveryStatus).toEqual({});
    });
  });

  describe('getAlertHistory', () => {
    it('should return empty array when no alerts exist', async () => {
      const history = await alertSystem.getAlertHistory();
      expect(history).toEqual([]);
    });

    it('should return alerts ordered by most recent first', async () => {
      await alertSystem.emitAlert({
        eventType: 'first',
        affectedResource: 'r1',
        severity: 'low',
        message: 'first',
      });

      // Small delay to ensure distinct timestamps
      await new Promise((r) => setTimeout(r, 10));

      await alertSystem.emitAlert({
        eventType: 'second',
        affectedResource: 'r2',
        severity: 'medium',
        message: 'second',
      });

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(2);
      expect(history[0].eventType).toBe('second');
      expect(history[1].eventType).toBe('first');
    });

    it('should limit history to 500 entries', async () => {
      const system = createAlertSystem(db, { maxHistorySize: 5 });

      for (let i = 0; i < 10; i++) {
        await system.emitAlert({
          eventType: `event_${i}`,
          affectedResource: 'test',
          severity: 'low',
          message: `Message ${i}`,
        });
      }

      const history = await system.getAlertHistory();
      expect(history.length).toBeLessThanOrEqual(5);
    });
  });

  describe('recordMetric - consecutive threshold logic', () => {
    it('should not fire alert for fewer than 3 consecutive breaches', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Only 2 breaches - should not fire
      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should fire alert after 3 consecutive threshold breaches', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);
      await alertSystem.recordMetric('cpu', 'server', 88);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].eventType).toBe('cpu_threshold_exceeded');
      expect(history[0].affectedResource).toBe('server');
    });

    it('should reset counter when value drops below threshold', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);
      // Value drops below threshold - should reset counter
      await alertSystem.recordMetric('cpu', 'server', 70);
      // Start counting again from 0
      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should track resources independently', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Server A breaches 3 times
      await alertSystem.recordMetric('cpu', 'serverA', 85);
      await alertSystem.recordMetric('cpu', 'serverA', 90);
      await alertSystem.recordMetric('cpu', 'serverA', 88);

      // Server B only breaches once
      await alertSystem.recordMetric('cpu', 'serverB', 85);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
      expect(history[0].affectedResource).toBe('serverA');
    });

    it('should not fire alert when metric is at threshold (not above)', async () => {
      await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
        consecutiveChecks: 3,
      });

      // Exactly at threshold - should NOT trigger (must exceed)
      await alertSystem.recordMetric('memory', 'server', 90);
      await alertSystem.recordMetric('memory', 'server', 90);
      await alertSystem.recordMetric('memory', 'server', 90);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(0);
    });

    it('should fire alert when metric exceeds threshold', async () => {
      await alertSystem.configureRule({
        resourceType: 'memory',
        threshold: 90,
        consecutiveChecks: 3,
      });

      await alertSystem.recordMetric('memory', 'server', 91);
      await alertSystem.recordMetric('memory', 'server', 92);
      await alertSystem.recordMetric('memory', 'server', 93);

      const history = await alertSystem.getAlertHistory();
      expect(history).toHaveLength(1);
    });

    it('should support custom consecutive check count', async () => {
      await alertSystem.configureRule({
        resourceType: 'disk',
        threshold: 85,
        consecutiveChecks: 5,
      });

      // 4 breaches - not enough for 5 consecutive
      for (let i = 0; i < 4; i++) {
        await alertSystem.recordMetric('disk', 'volume', 90);
      }
      expect(await alertSystem.getAlertHistory()).toHaveLength(0);

      // 5th breach triggers
      await alertSystem.recordMetric('disk', 'volume', 90);
      expect(await alertSystem.getAlertHistory()).toHaveLength(1);
    });
  });

  describe('removeChannel', () => {
    it('should remove a channel by ID', async () => {
      const id = await alertSystem.configureChannel({
        type: 'webhook',
        config: { url: 'https://hooks.example.com' },
      });

      alertSystem.removeChannel(id);

      const channels = alertSystem.getChannels();
      expect(channels).toHaveLength(0);
    });
  });

  describe('removeRule', () => {
    it('should remove a rule by ID', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
      });

      alertSystem.removeRule(id);

      const rules = alertSystem.getRules();
      expect(rules).toHaveLength(0);
    });

    it('should clean up threshold trackers when rule is removed', async () => {
      const id = await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Record 2 breaches (below threshold to fire)
      await alertSystem.recordMetric('cpu', 'server', 85);
      await alertSystem.recordMetric('cpu', 'server', 90);

      // Remove the rule
      alertSystem.removeRule(id);

      // Re-add the same rule type
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 3,
      });

      // Should need 3 fresh breaches now
      await alertSystem.recordMetric('cpu', 'server', 85);
      expect(await alertSystem.getAlertHistory()).toHaveLength(0);
    });
  });

  describe('alert severity determination', () => {
    it('should assign critical severity for values >= 95%', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 1,
      });

      await alertSystem.recordMetric('cpu', 'server', 96);

      const history = await alertSystem.getAlertHistory();
      expect(history[0].severity).toBe('critical');
    });

    it('should assign high severity for values >= 90%', async () => {
      await alertSystem.configureRule({
        resourceType: 'cpu',
        threshold: 80,
        consecutiveChecks: 1,
      });

      await alertSystem.recordMetric('cpu', 'server', 91);

      const history = await alertSystem.getAlertHistory();
      expect(history[0].severity).toBe('high');
    });
  });
});
