/**
 * Log Viewer Unit Tests
 *
 * Tests for container log retrieval, real-time streaming,
 * search filtering, time range filtering, and stdout/stderr distinction.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogViewer, parseMultiplexedLogs, parseLine, getTimeSince } from '../../src/modules/log-viewer.js';
import type { LogViewer, LogEntry, LogStream } from '../../src/modules/log-viewer.js';

// ─── Mock Dockerode ────────────────────────────────────────────────────────────

const mockContainer = {
  logs: vi.fn(),
};

const mockDocker = {
  getContainer: vi.fn(() => mockContainer),
};

vi.mock('dockerode', () => {
  return {
    default: vi.fn(() => mockDocker),
  };
});

// ─── Mock Socket.IO ────────────────────────────────────────────────────────────

const mockEmit = vi.fn();
const mockTo = vi.fn(() => ({ emit: mockEmit }));
const mockIo = { to: mockTo } as any;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a Docker multiplexed log frame.
 * Byte 0: stream type (1=stdout, 2=stderr)
 * Bytes 1-3: padding
 * Bytes 4-7: payload size (big-endian uint32)
 * Followed by the payload
 */
function buildLogFrame(stream: 'stdout' | 'stderr', payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = stream === 'stdout' ? 1 : 2;
  header.writeUInt32BE(payloadBuf.length, 4);
  return Buffer.concat([header, payloadBuf]);
}

/**
 * Build multiple log frames into a single buffer.
 */
function buildMultipleFrames(
  frames: Array<{ stream: 'stdout' | 'stderr'; payload: string }>
): Buffer {
  return Buffer.concat(frames.map((f) => buildLogFrame(f.stream, f.payload)));
}

// ─── Test Data ─────────────────────────────────────────────────────────────────

const NOW = new Date('2024-06-15T12:00:00.000Z');
const ONE_HOUR_AGO = new Date('2024-06-15T11:00:00.000Z');
const SIX_HOURS_AGO = new Date('2024-06-15T06:00:00.000Z');
const ONE_DAY_AGO = new Date('2024-06-14T12:00:00.000Z');

function createSampleLogs(): LogEntry[] {
  return [
    { timestamp: new Date('2024-06-15T11:55:00.000Z'), content: 'Server started on port 3000', stream: 'stdout' },
    { timestamp: new Date('2024-06-15T11:56:00.000Z'), content: 'Database connected', stream: 'stdout' },
    { timestamp: new Date('2024-06-15T11:57:00.000Z'), content: 'Warning: deprecated API call', stream: 'stderr' },
    { timestamp: new Date('2024-06-15T05:30:00.000Z'), content: 'Old log entry from morning', stream: 'stdout' },
    { timestamp: new Date('2024-06-14T10:00:00.000Z'), content: 'Yesterday error: connection reset', stream: 'stderr' },
    { timestamp: new Date('2024-06-15T11:58:00.000Z'), content: 'GET /api/users 200 15ms', stream: 'stdout' },
    { timestamp: new Date('2024-06-15T11:59:00.000Z'), content: 'Error: ECONNREFUSED 127.0.0.1:5432', stream: 'stderr' },
  ];
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Log Viewer', () => {
  let viewer: LogViewer;

  beforeEach(() => {
    vi.clearAllMocks();
    viewer = createLogViewer({
      dockerHost: '/var/run/docker.sock',
      io: mockIo,
    });
  });

  // ─── getContainerLogs ──────────────────────────────────────────────────

  describe('getContainerLogs', () => {
    it('should retrieve logs with default options (500 lines, timestamps)', async () => {
      const timestamp = '2024-06-15T12:00:00.000000000Z';
      const logBuffer = buildMultipleFrames([
        { stream: 'stdout', payload: `${timestamp} Server started\n` },
        { stream: 'stderr', payload: `${timestamp} Warning message\n` },
      ]);
      mockContainer.logs.mockResolvedValue(logBuffer);

      const logs = await viewer.getContainerLogs('container-123');

      expect(mockDocker.getContainer).toHaveBeenCalledWith('container-123');
      expect(mockContainer.logs).toHaveBeenCalledWith(
        expect.objectContaining({
          stdout: true,
          stderr: true,
          tail: 500,
          timestamps: true,
          follow: false,
        })
      );
      expect(logs).toHaveLength(2);
    });

    it('should pass custom tail option', async () => {
      mockContainer.logs.mockResolvedValue(Buffer.alloc(0));

      await viewer.getContainerLogs('container-123', { tail: 100 });

      expect(mockContainer.logs).toHaveBeenCalledWith(
        expect.objectContaining({ tail: 100 })
      );
    });

    it('should apply time range as "since" parameter for non-all ranges', async () => {
      mockContainer.logs.mockResolvedValue(Buffer.alloc(0));

      await viewer.getContainerLogs('container-123', { timeRange: '1h' });

      expect(mockContainer.logs).toHaveBeenCalledWith(
        expect.objectContaining({
          since: expect.any(Number),
        })
      );
    });

    it('should not include "since" for "all" time range', async () => {
      mockContainer.logs.mockResolvedValue(Buffer.alloc(0));

      await viewer.getContainerLogs('container-123', { timeRange: 'all' });

      const callArgs = mockContainer.logs.mock.calls[0][0];
      expect(callArgs.since).toBeUndefined();
    });

    it('should distinguish stdout and stderr streams', async () => {
      const timestamp = '2024-06-15T12:00:00.000000000Z';
      const logBuffer = buildMultipleFrames([
        { stream: 'stdout', payload: `${timestamp} Stdout message\n` },
        { stream: 'stderr', payload: `${timestamp} Stderr message\n` },
        { stream: 'stdout', payload: `${timestamp} Another stdout\n` },
      ]);
      mockContainer.logs.mockResolvedValue(logBuffer);

      const logs = await viewer.getContainerLogs('container-123');

      expect(logs[0].stream).toBe('stdout');
      expect(logs[0].content).toBe('Stdout message');
      expect(logs[1].stream).toBe('stderr');
      expect(logs[1].content).toBe('Stderr message');
      expect(logs[2].stream).toBe('stdout');
      expect(logs[2].content).toBe('Another stdout');
    });

    it('should parse timestamps from log entries', async () => {
      const timestamp = '2024-06-15T12:00:00.000000000Z';
      const logBuffer = buildLogFrame('stdout', `${timestamp} Hello world\n`);
      mockContainer.logs.mockResolvedValue(logBuffer);

      const logs = await viewer.getContainerLogs('container-123');

      expect(logs[0].timestamp).toEqual(new Date('2024-06-15T12:00:00.000Z'));
      expect(logs[0].content).toBe('Hello world');
    });

    it('should handle empty log output', async () => {
      mockContainer.logs.mockResolvedValue(Buffer.alloc(0));

      const logs = await viewer.getContainerLogs('container-123');

      expect(logs).toHaveLength(0);
    });

    it('should handle stopped containers (historical logs)', async () => {
      // Stopped containers still return logs via the same API
      const timestamp = '2024-06-14T10:00:00.000000000Z';
      const logBuffer = buildLogFrame('stdout', `${timestamp} Last log before stop\n`);
      mockContainer.logs.mockResolvedValue(logBuffer);

      const logs = await viewer.getContainerLogs('stopped-container');

      expect(logs).toHaveLength(1);
      expect(logs[0].content).toBe('Last log before stop');
    });

    it('should handle string response (TTY mode)', async () => {
      const logString = '2024-06-15T12:00:00.000000000Z Line one\n2024-06-15T12:01:00.000000000Z Line two\n';
      mockContainer.logs.mockResolvedValue(logString);

      const logs = await viewer.getContainerLogs('tty-container');

      expect(logs).toHaveLength(2);
      expect(logs[0].content).toBe('Line one');
      expect(logs[1].content).toBe('Line two');
    });

    it('should handle multi-line payloads in a single frame', async () => {
      const timestamp = '2024-06-15T12:00:00.000000000Z';
      const logBuffer = buildLogFrame(
        'stdout',
        `${timestamp} Line 1\n${timestamp} Line 2\n${timestamp} Line 3\n`
      );
      mockContainer.logs.mockResolvedValue(logBuffer);

      const logs = await viewer.getContainerLogs('container-123');

      expect(logs).toHaveLength(3);
    });
  });

  // ─── startLogStream ────────────────────────────────────────────────────

  describe('startLogStream', () => {
    it('should throw if Socket.IO is not configured', () => {
      const viewerNoIo = createLogViewer({
        dockerHost: '/var/run/docker.sock',
      });

      expect(() => viewerNoIo.startLogStream('container-123', 'room-1')).toThrow(
        'Socket.IO server not configured'
      );
    });

    it('should call container.logs with follow=true', () => {
      mockContainer.logs.mockImplementation((_opts: any, cb: any) => {
        // Simulate an immediate callback with an empty stream
        const { EventEmitter } = require('events');
        const stream = new EventEmitter();
        cb(null, stream);
      });

      viewer.startLogStream('container-123', 'logs:container-123');

      expect(mockContainer.logs).toHaveBeenCalledWith(
        expect.objectContaining({
          stdout: true,
          stderr: true,
          follow: true,
          timestamps: true,
        }),
        expect.any(Function)
      );
    });

    it('should emit log:error on stream setup failure', () => {
      mockContainer.logs.mockImplementation((_opts: any, cb: any) => {
        cb(new Error('Container not running'), null);
      });

      viewer.startLogStream('container-123', 'logs:container-123');

      expect(mockTo).toHaveBeenCalledWith('logs:container-123');
      expect(mockEmit).toHaveBeenCalledWith('log:error', {
        containerId: 'container-123',
        error: 'Container not running',
      });
    });

    it('should emit log entries when data arrives on stream', () => {
      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      (stream as any).destroy = vi.fn();

      mockContainer.logs.mockImplementation((_opts: any, cb: any) => {
        cb(null, stream);
      });

      viewer.startLogStream('container-123', 'logs:container-123');

      // Simulate incoming log data
      const timestamp = '2024-06-15T12:00:00.000000000Z';
      const frame = buildLogFrame('stdout', `${timestamp} New log entry\n`);
      stream.emit('data', frame);

      expect(mockTo).toHaveBeenCalledWith('logs:container-123');
      expect(mockEmit).toHaveBeenCalledWith('log:entry', {
        containerId: 'container-123',
        entry: expect.objectContaining({
          content: 'New log entry',
          stream: 'stdout',
        }),
      });
    });

    it('should emit log:end when stream ends', () => {
      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      (stream as any).destroy = vi.fn();

      mockContainer.logs.mockImplementation((_opts: any, cb: any) => {
        cb(null, stream);
      });

      viewer.startLogStream('container-123', 'logs:container-123');
      stream.emit('end');

      expect(mockEmit).toHaveBeenCalledWith('log:end', { containerId: 'container-123' });
    });

    it('should stop previous stream before starting a new one for same container', () => {
      const { EventEmitter } = require('events');
      const stream1 = new EventEmitter();
      (stream1 as any).destroy = vi.fn();
      const stream2 = new EventEmitter();
      (stream2 as any).destroy = vi.fn();

      let callCount = 0;
      mockContainer.logs.mockImplementation((_opts: any, cb: any) => {
        callCount++;
        cb(null, callCount === 1 ? stream1 : stream2);
      });

      viewer.startLogStream('container-123', 'room-1');
      viewer.startLogStream('container-123', 'room-2');

      expect((stream1 as any).destroy).toHaveBeenCalled();
    });
  });

  // ─── stopLogStream ─────────────────────────────────────────────────────

  describe('stopLogStream', () => {
    it('should stop an active log stream', () => {
      const { EventEmitter } = require('events');
      const stream = new EventEmitter();
      (stream as any).destroy = vi.fn();

      mockContainer.logs.mockImplementation((_opts: any, cb: any) => {
        cb(null, stream);
      });

      viewer.startLogStream('container-123', 'room-1');
      viewer.stopLogStream('container-123');

      expect((stream as any).destroy).toHaveBeenCalled();
    });

    it('should be a no-op for containers with no active stream', () => {
      // Should not throw
      expect(() => viewer.stopLogStream('nonexistent')).not.toThrow();
    });
  });

  // ─── filterLogs ────────────────────────────────────────────────────────

  describe('filterLogs', () => {
    it('should filter logs case-insensitively', () => {
      const logs = createSampleLogs();

      const result = viewer.filterLogs(logs, 'error');

      // Matches: "Yesterday error: connection reset", "Error: ECONNREFUSED..."
      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('error');
      expect(result[1].content).toContain('Error');
    });

    it('should match partial content', () => {
      const logs = createSampleLogs();

      const result = viewer.filterLogs(logs, 'port');

      // Matches: "Server started on port 3000"
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('port');
    });

    it('should return empty array for search term shorter than 1 char', () => {
      const logs = createSampleLogs();

      const result = viewer.filterLogs(logs, '');

      expect(result).toHaveLength(0);
    });

    it('should return empty array for search term longer than 200 chars', () => {
      const logs = createSampleLogs();
      const longSearch = 'a'.repeat(201);

      const result = viewer.filterLogs(logs, longSearch);

      expect(result).toHaveLength(0);
    });

    it('should accept search term of exactly 1 character', () => {
      const logs: LogEntry[] = [
        { timestamp: new Date(), content: 'abc', stream: 'stdout' },
        { timestamp: new Date(), content: 'def', stream: 'stdout' },
      ];

      const result = viewer.filterLogs(logs, 'a');

      expect(result).toHaveLength(1);
    });

    it('should accept search term of exactly 200 characters', () => {
      const searchTerm = 'a'.repeat(200);
      const logs: LogEntry[] = [
        { timestamp: new Date(), content: searchTerm + ' extra', stream: 'stdout' },
        { timestamp: new Date(), content: 'no match', stream: 'stdout' },
      ];

      const result = viewer.filterLogs(logs, searchTerm);

      expect(result).toHaveLength(1);
    });

    it('should return empty array when no entries match (Req 4.7)', () => {
      const logs = createSampleLogs();

      const result = viewer.filterLogs(logs, 'nonexistent_term_xyz');

      expect(result).toHaveLength(0);
    });

    it('should preserve log entry properties in filtered results', () => {
      const logs = createSampleLogs();

      const result = viewer.filterLogs(logs, 'Database');

      expect(result).toHaveLength(1);
      expect(result[0].stream).toBe('stdout');
      expect(result[0].timestamp).toBeInstanceOf(Date);
      expect(result[0].content).toBe('Database connected');
    });
  });

  // ─── filterByTimeRange ─────────────────────────────────────────────────

  describe('filterByTimeRange', () => {
    it('should return all logs for "all" range', () => {
      const logs = createSampleLogs();

      const result = viewer.filterByTimeRange(logs, 'all');

      expect(result).toHaveLength(logs.length);
    });

    it('should filter logs from the last 1 hour', () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      const logs = createSampleLogs();

      const result = viewer.filterByTimeRange(logs, '1h');

      // Entries within the last hour (11:00 - 12:00): 11:55, 11:56, 11:57, 11:58, 11:59
      expect(result.length).toBe(5);
      for (const entry of result) {
        expect(entry.timestamp.getTime()).toBeGreaterThanOrEqual(ONE_HOUR_AGO.getTime());
      }

      vi.useRealTimers();
    });

    it('should filter logs from the last 6 hours', () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      const logs = createSampleLogs();

      const result = viewer.filterByTimeRange(logs, '6h');

      // Entries within last 6 hours (06:00 - 12:00): 11:55, 11:56, 11:57, 11:58, 11:59
      // 05:30 is outside (6.5 hours ago), yesterday is outside
      expect(result.length).toBe(5);
      for (const entry of result) {
        expect(entry.timestamp.getTime()).toBeGreaterThanOrEqual(SIX_HOURS_AGO.getTime());
      }

      vi.useRealTimers();
    });

    it('should filter logs from the last 24 hours', () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      const logs = createSampleLogs();

      const result = viewer.filterByTimeRange(logs, '24h');

      // Entries within last 24 hours: all except 2024-06-14T10:00 (26 hours ago)
      expect(result.length).toBe(6);

      vi.useRealTimers();
    });

    it('should exclude entries older than the time range', () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);

      const logs: LogEntry[] = [
        { timestamp: new Date('2024-06-15T11:30:00.000Z'), content: 'Recent', stream: 'stdout' },
        { timestamp: new Date('2024-06-14T00:00:00.000Z'), content: 'Old', stream: 'stdout' },
      ];

      const result = viewer.filterByTimeRange(logs, '1h');

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('Recent');

      vi.useRealTimers();
    });
  });

  // ─── parseMultiplexedLogs ──────────────────────────────────────────────

  describe('parseMultiplexedLogs', () => {
    it('should parse stdout frames correctly', () => {
      const buffer = buildLogFrame('stdout', '2024-06-15T12:00:00.000Z Hello\n');

      const entries = parseMultiplexedLogs(buffer, true);

      expect(entries).toHaveLength(1);
      expect(entries[0].stream).toBe('stdout');
      expect(entries[0].content).toBe('Hello');
    });

    it('should parse stderr frames correctly', () => {
      const buffer = buildLogFrame('stderr', '2024-06-15T12:00:00.000Z Error occurred\n');

      const entries = parseMultiplexedLogs(buffer, true);

      expect(entries).toHaveLength(1);
      expect(entries[0].stream).toBe('stderr');
      expect(entries[0].content).toBe('Error occurred');
    });

    it('should parse multiple consecutive frames', () => {
      const buffer = buildMultipleFrames([
        { stream: 'stdout', payload: '2024-06-15T12:00:00.000Z Line 1\n' },
        { stream: 'stderr', payload: '2024-06-15T12:01:00.000Z Line 2\n' },
        { stream: 'stdout', payload: '2024-06-15T12:02:00.000Z Line 3\n' },
      ]);

      const entries = parseMultiplexedLogs(buffer, true);

      expect(entries).toHaveLength(3);
      expect(entries[0].stream).toBe('stdout');
      expect(entries[1].stream).toBe('stderr');
      expect(entries[2].stream).toBe('stdout');
    });

    it('should handle frames without timestamps', () => {
      const buffer = buildLogFrame('stdout', 'No timestamp here\n');

      const entries = parseMultiplexedLogs(buffer, false);

      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('No timestamp here');
      expect(entries[0].timestamp).toBeInstanceOf(Date);
    });

    it('should handle empty buffer', () => {
      const entries = parseMultiplexedLogs(Buffer.alloc(0), true);

      expect(entries).toHaveLength(0);
    });

    it('should handle truncated buffer (incomplete header)', () => {
      // Less than 8 bytes
      const entries = parseMultiplexedLogs(Buffer.alloc(4), true);

      expect(entries).toHaveLength(0);
    });

    it('should handle truncated buffer (incomplete payload)', () => {
      // Header says 100 bytes but only 5 available
      const header = Buffer.alloc(8);
      header[0] = 1; // stdout
      header.writeUInt32BE(100, 4); // claims 100 bytes
      const partialPayload = Buffer.from('Hello');
      const buffer = Buffer.concat([header, partialPayload]);

      const entries = parseMultiplexedLogs(buffer, false);

      expect(entries).toHaveLength(0);
    });
  });

  // ─── parseLine ─────────────────────────────────────────────────────────

  describe('parseLine', () => {
    it('should parse line with timestamp', () => {
      const entry = parseLine('2024-06-15T12:00:00.000Z Hello world', 'stdout', true);

      expect(entry).not.toBeNull();
      expect(entry!.timestamp).toEqual(new Date('2024-06-15T12:00:00.000Z'));
      expect(entry!.content).toBe('Hello world');
      expect(entry!.stream).toBe('stdout');
    });

    it('should parse line without timestamp', () => {
      const entry = parseLine('Just a plain message', 'stderr', false);

      expect(entry).not.toBeNull();
      expect(entry!.content).toBe('Just a plain message');
      expect(entry!.stream).toBe('stderr');
      expect(entry!.timestamp).toBeInstanceOf(Date);
    });

    it('should handle line with invalid timestamp', () => {
      const entry = parseLine('not-a-date some content', 'stdout', true);

      expect(entry).not.toBeNull();
      // Falls back to using the entire line as content with current timestamp
      expect(entry!.content).toBe('not-a-date some content');
    });

    it('should return null for empty line', () => {
      const entry = parseLine('', 'stdout', true);

      expect(entry).toBeNull();
    });

    it('should handle Docker nanosecond timestamp format', () => {
      const entry = parseLine('2024-06-15T12:00:00.123456789Z Application ready', 'stdout', true);

      expect(entry).not.toBeNull();
      expect(entry!.content).toBe('Application ready');
      // JS Date truncates nanoseconds but should still parse
      expect(entry!.timestamp.getFullYear()).toBe(2024);
    });
  });

  // ─── getTimeSince ──────────────────────────────────────────────────────

  describe('getTimeSince', () => {
    it('should return timestamp 1 hour ago for "1h"', () => {
      const now = new Date('2024-06-15T12:00:00.000Z');
      const since = getTimeSince('1h', now);

      // 12:00:00 UTC in seconds - 3600
      const expected = Math.floor(now.getTime() / 1000) - 3600;
      expect(since).toBe(expected);
    });

    it('should return timestamp 6 hours ago for "6h"', () => {
      const now = new Date('2024-06-15T12:00:00.000Z');
      const since = getTimeSince('6h', now);

      const expected = Math.floor(now.getTime() / 1000) - 21600;
      expect(since).toBe(expected);
    });

    it('should return timestamp 24 hours ago for "24h"', () => {
      const now = new Date('2024-06-15T12:00:00.000Z');
      const since = getTimeSince('24h', now);

      const expected = Math.floor(now.getTime() / 1000) - 86400;
      expect(since).toBe(expected);
    });

    it('should return 0 for "all"', () => {
      const since = getTimeSince('all');

      expect(since).toBe(0);
    });
  });
});
