/**
 * Resource Widget Unit Tests
 *
 * Tests for system and container resource metrics collection,
 * /proc fallback behavior, monitoring loop, and warning thresholds.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createResourceWidget } from '../../src/modules/resource-widget.js';
import type { ResourceWidget, SocketIOServer } from '../../src/modules/resource-widget.js';

// ─── Mock Dockerode ────────────────────────────────────────────────────────────

const mockContainer = {
  stats: vi.fn(),
};

const mockDocker = {
  listContainers: vi.fn(),
  getContainer: vi.fn(() => mockContainer),
};

vi.mock('dockerode', () => {
  return {
    default: vi.fn(() => mockDocker),
  };
});

// ─── Mock fs/promises ──────────────────────────────────────────────────────────

const mockFsReadFile = vi.fn();
const mockFsAccess = vi.fn();
const mockStatfs = vi.fn();

vi.mock('fs/promises', () => {
  return {
    readFile: (...args: any[]) => mockFsReadFile(...args),
    access: (...args: any[]) => mockFsAccess(...args),
    constants: { R_OK: 4 },
    statfs: (...args: any[]) => mockStatfs(...args),
  };
});

// ─── Test Data ─────────────────────────────────────────────────────────────────

const PROC_STAT_CONTENT = `cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0
cpu0 1393280 32966 572056 13343292 6130 0 17875 0 0 0
`;

const PROC_MEMINFO_CONTENT = `MemTotal:       16384000 kB
MemFree:         2048000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB
`;

const PROC_NET_DEV_CONTENT = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1234567   12345    0    0    0     0          0         0  1234567   12345    0    0    0     0       0          0
  eth0: 98765432  654321    0    0    0     0          0         0 45678901  321654    0    0    0     0       0          0
`;

const MOCK_CONTAINER_STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 500000000 },
    system_cpu_usage: 10000000000,
    online_cpus: 4,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 400000000 },
    system_cpu_usage: 9000000000,
  },
  memory_stats: {
    usage: 256 * 1024 * 1024, // 256 MB
    stats: { cache: 0 },
    limit: 1024 * 1024 * 1024, // 1 GB
  },
};

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ResourceWidget', () => {
  let widget: ResourceWidget;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isProcAvailable', () => {
    it('should return true when /proc/stat and /proc/meminfo are accessible', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      widget = createResourceWidget();

      const result = await widget.isProcAvailable();
      expect(result).toBe(true);
    });

    it('should return false when /proc files are not accessible', async () => {
      mockFsAccess.mockRejectedValue(new Error('ENOENT'));
      widget = createResourceWidget();

      const result = await widget.isProcAvailable();
      expect(result).toBe(false);
    });
  });

  describe('getSystemMetrics', () => {
    it('should read metrics from /proc when available', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) return Promise.resolve(PROC_MEMINFO_CONTENT);
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });

      widget = createResourceWidget();

      const metrics = await widget.getSystemMetrics();

      expect(metrics.procAvailable).toBe(true);
      expect(metrics.memory.totalGB).toBeCloseTo(15.63, 1);
      expect(metrics.memory.usedGB).toBeCloseTo(7.81, 1);
      expect(metrics.memory.usagePercent).toBeCloseTo(50, 0);
      expect(metrics.disk.usagePercent).toBeCloseTo(50, 0);
    });

    it('should fall back when /proc is not available', async () => {
      mockFsAccess.mockRejectedValue(new Error('ENOENT'));
      widget = createResourceWidget();

      const metrics = await widget.getSystemMetrics();

      expect(metrics.procAvailable).toBe(false);
      expect(metrics.cpu.usagePercent).toBe(0);
      expect(metrics.memory.usedGB).toBe(0);
      expect(metrics.memory.totalGB).toBe(0);
    });

    it('should flag warning when memory exceeds 90% utilization', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) {
          // 95% utilization
          return Promise.resolve(
            `MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:     819200 kB\n`
          );
        }
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 5000000, // ~5% free = 95% used
      });

      widget = createResourceWidget();

      const metrics = await widget.getSystemMetrics();

      expect(metrics.memory.warning).toBe(true);
      expect(metrics.disk.warning).toBe(true);
    });

    it('should not flag warning when resources are below 90%', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) return Promise.resolve(PROC_MEMINFO_CONTENT);
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });

      widget = createResourceWidget();

      const metrics = await widget.getSystemMetrics();

      expect(metrics.memory.warning).toBe(false);
      expect(metrics.disk.warning).toBe(false);
    });
  });

  describe('getContainerMetrics', () => {
    it('should return per-container CPU % and memory MB', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { Id: 'container-1', Names: ['/web-app'], State: 'running' },
      ]);
      mockContainer.stats.mockResolvedValue(MOCK_CONTAINER_STATS);

      widget = createResourceWidget();

      const metrics = await widget.getContainerMetrics();

      expect(metrics).toHaveLength(1);
      expect(metrics[0].id).toBe('container-1');
      expect(metrics[0].name).toBe('web-app');
      expect(metrics[0].cpuPercent).toBeGreaterThan(0);
      expect(metrics[0].memoryMB).toBeCloseTo(256, 0);
    });

    it('should flag warning when container CPU exceeds 90%', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { Id: 'container-1', Names: ['/cpu-heavy'], State: 'running' },
      ]);
      // Simulate ~95% CPU usage
      mockContainer.stats.mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 9500000000 },
          system_cpu_usage: 10000000000,
          online_cpus: 1,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 0 },
          system_cpu_usage: 0,
        },
        memory_stats: {
          usage: 100 * 1024 * 1024,
          stats: { cache: 0 },
          limit: 1024 * 1024 * 1024,
        },
      });

      widget = createResourceWidget();

      const metrics = await widget.getContainerMetrics();

      expect(metrics[0].cpuPercent).toBeGreaterThanOrEqual(90);
      expect(metrics[0].warning).toBe(true);
    });

    it('should skip containers that fail stats retrieval', async () => {
      mockDocker.listContainers.mockResolvedValue([
        { Id: 'container-1', Names: ['/working'], State: 'running' },
        { Id: 'container-2', Names: ['/broken'], State: 'running' },
      ]);
      mockDocker.getContainer.mockImplementation((id: string) => {
        if (id === 'container-2') {
          return { stats: vi.fn().mockRejectedValue(new Error('Not available')) };
        }
        return mockContainer;
      });
      mockContainer.stats.mockResolvedValue(MOCK_CONTAINER_STATS);

      widget = createResourceWidget();

      const metrics = await widget.getContainerMetrics();

      expect(metrics).toHaveLength(1);
      expect(metrics[0].name).toBe('working');
    });
  });

  describe('startMonitoring / stopMonitoring', () => {
    it('should emit resource:update events via Socket.IO every 5 seconds', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) return Promise.resolve(PROC_MEMINFO_CONTENT);
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });
      mockDocker.listContainers.mockResolvedValue([]);

      const mockIO: SocketIOServer = { emit: vi.fn() };
      widget = createResourceWidget({ updateIntervalMs: 5000 });

      widget.startMonitoring(mockIO);

      // Allow the immediate first collection to execute
      await vi.advanceTimersByTimeAsync(0);

      expect(mockIO.emit).toHaveBeenCalledWith('resource:update', expect.objectContaining({
        system: expect.any(Object),
        containers: expect.any(Array),
        timestamp: expect.any(Number),
        warnings: expect.any(Array),
      }));

      // Advance by 5 seconds for another update
      await vi.advanceTimersByTimeAsync(5000);

      expect((mockIO.emit as any).mock.calls.length).toBeGreaterThanOrEqual(2);

      widget.stopMonitoring();
    });

    it('should stop emitting after stopMonitoring is called', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) return Promise.resolve(PROC_MEMINFO_CONTENT);
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });
      mockDocker.listContainers.mockResolvedValue([]);

      const mockIO: SocketIOServer = { emit: vi.fn() };
      widget = createResourceWidget({ updateIntervalMs: 5000 });

      widget.startMonitoring(mockIO);
      await vi.advanceTimersByTimeAsync(0);

      widget.stopMonitoring();

      const callCountAfterStop = (mockIO.emit as any).mock.calls.length;

      await vi.advanceTimersByTimeAsync(10000);

      expect((mockIO.emit as any).mock.calls.length).toBe(callCountAfterStop);
    });

    it('should not start multiple intervals if startMonitoring is called twice', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) return Promise.resolve(PROC_MEMINFO_CONTENT);
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });
      mockDocker.listContainers.mockResolvedValue([]);

      const mockIO: SocketIOServer = { emit: vi.fn() };
      widget = createResourceWidget({ updateIntervalMs: 5000 });

      widget.startMonitoring(mockIO);
      widget.startMonitoring(mockIO); // second call should be a no-op

      await vi.advanceTimersByTimeAsync(5000);

      // Should only have emitted from one interval, not two
      // Initial + 1 interval = 2 calls max
      expect((mockIO.emit as any).mock.calls.length).toBeLessThanOrEqual(2);

      widget.stopMonitoring();
    });
  });

  describe('warning thresholds', () => {
    it('should include warnings array when resources exceed threshold', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) {
          return Promise.resolve(
            `MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:     819200 kB\n`
          );
        }
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });
      mockDocker.listContainers.mockResolvedValue([]);

      const mockIO: SocketIOServer = { emit: vi.fn() };
      widget = createResourceWidget({ updateIntervalMs: 5000 });

      widget.startMonitoring(mockIO);
      await vi.advanceTimersByTimeAsync(0);

      const emittedData = (mockIO.emit as any).mock.calls[0][1];
      expect(emittedData.warnings.length).toBeGreaterThan(0);
      expect(emittedData.warnings.some((w: string) => w.includes('memory'))).toBe(true);

      widget.stopMonitoring();
    });

    it('should support custom warning threshold', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) {
          // 85% used - above 80% threshold but below default 90%
          return Promise.resolve(
            `MemTotal:       16384000 kB\nMemFree:          200000 kB\nMemAvailable:    2457600 kB\n`
          );
        }
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });

      widget = createResourceWidget({ warningThreshold: 80 });

      const metrics = await widget.getSystemMetrics();

      expect(metrics.memory.warning).toBe(true);
    });
  });

  describe('getLatestUpdate', () => {
    it('should return null before monitoring starts', () => {
      widget = createResourceWidget();
      expect(widget.getLatestUpdate()).toBeNull();
    });

    it('should return the last collected update', async () => {
      mockFsAccess.mockResolvedValue(undefined);
      mockFsReadFile.mockImplementation((path: string) => {
        if (path.includes('stat')) return Promise.resolve(PROC_STAT_CONTENT);
        if (path.includes('meminfo')) return Promise.resolve(PROC_MEMINFO_CONTENT);
        if (path.includes('net/dev')) return Promise.resolve(PROC_NET_DEV_CONTENT);
        return Promise.reject(new Error('Unknown file'));
      });
      mockStatfs.mockResolvedValue({
        blocks: 100000000,
        bsize: 4096,
        bfree: 50000000,
      });
      mockDocker.listContainers.mockResolvedValue([]);

      const mockIO: SocketIOServer = { emit: vi.fn() };
      widget = createResourceWidget({ updateIntervalMs: 5000 });

      widget.startMonitoring(mockIO);
      await vi.advanceTimersByTimeAsync(0);

      const update = widget.getLatestUpdate();
      expect(update).not.toBeNull();
      expect(update!.system).toBeDefined();
      expect(update!.containers).toBeDefined();
      expect(update!.timestamp).toBeGreaterThan(0);

      widget.stopMonitoring();
    });
  });
});
